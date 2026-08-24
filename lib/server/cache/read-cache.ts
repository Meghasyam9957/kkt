import '@/lib/server/only';
import type { EnvLike } from '@/lib/shared/env';
/**
 * SERVER-SIDE READ CACHE.
 *
 * Google Sheets allows roughly 60 reads per minute per user. A dashboard that reads the
 * workbook once per page view would exhaust that with a handful of operators, so reads
 * are cached — but a cache over financial data is a way to show someone last week's
 * numbers and call them current, so every rule here is about preventing that.
 *
 *   1. BOUNDED TTL. The TTL is clamped to a sane range; a misconfigured environment
 *      variable cannot produce a cache that never expires.
 *   2. AN EXPLICIT REFRESH IS ALWAYS A REAL READ. It bypasses the entry entirely; there
 *      is no code path where "Refresh" returns what was already on screen.
 *   3. THE KEY CONTAINS THE FILTERS. Two different months are two different entries.
 *   4. A FAILED LOAD NEVER OVERWRITES GOOD DATA. The previous value survives, and is
 *      returned marked stale with the error attached, so the UI can say what happened.
 *   5. IDENTITY IS PART OF THE KEY. Investor-scoped data is stored per investor, and a
 *      resource declared investor-scoped cannot be cached without one. Serving investor
 *      A's figures to investor B from a shared entry is the failure this prevents.
 *
 * Invalidation is time-based plus explicit. There is no write path in this phase, so
 * nothing else can make an entry wrong; when writes arrive they must call `invalidate()`
 * for the resources they touch.
 */

/* ------------------------------------------------------------------ *
 * Keys
 * ------------------------------------------------------------------ */

export type FilterValue = string | number | boolean | null | undefined;

export interface CacheKeyParts {
  /** Logical resource, e.g. 'workbook', 'dashboard', 'investor.overview'. */
  resource: string;
  /**
   * The investor this data belongs to, or null for management-wide data. Always present
   * in the key, so an entry can never be shared across identities by accident.
   */
  identity: string | null;
  /** Everything that changes the result: month, property, platform… */
  filters?: Record<string, FilterValue>;
}

/**
 * Resources whose rows differ per investor. Caching one of these without an identity is
 * a programming error, not a configuration choice — so it throws rather than degrading.
 */
export const IDENTITY_SCOPED_RESOURCES: ReadonlySet<string> = new Set([
  'investor.overview',
  'investor.statements',
  'investor.distributions',
  'investor.allocations',
]);

export class CacheIdentityError extends Error {
  constructor(resource: string) {
    super(`Refusing to cache '${resource}' without an investor identity: it is investor-scoped data.`);
    this.name = 'CacheIdentityError';
  }
}

/** Deterministic key: same inputs in any property order produce the same string. */
export function buildCacheKey(parts: CacheKeyParts): string {
  if (IDENTITY_SCOPED_RESOURCES.has(parts.resource) && !parts.identity) {
    throw new CacheIdentityError(parts.resource);
  }
  const filters = Object.entries(parts.filters ?? {})
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${String(v)}`)
    .join('&');
  return `${parts.resource}|identity=${parts.identity ?? '-'}|${filters}`;
}

/* ------------------------------------------------------------------ *
 * Cache
 * ------------------------------------------------------------------ */

export type CacheOutcome = 'HIT' | 'MISS' | 'REFRESH';

export interface CacheResult<T> {
  value: T;
  key: string;
  outcome: CacheOutcome;
  /** When the value was actually fetched from the source. */
  storedAt: Date;
  ageMs: number;
  /** True when the value is past its TTL — served only because a fresh read failed. */
  stale: boolean;
  /** The failure that forced a stale serve, if any. */
  error: Error | null;
}

interface Entry<T> {
  value: T;
  storedAt: number;
  expiresAt: number;
  lastAccess: number;
}

export interface ReadCacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  now?: () => number;
}

/** Hard bounds. A TTL outside these is a mistake, so it is clamped rather than honoured. */
export const MIN_TTL_MS = 5_000;
export const MAX_TTL_MS = 600_000;
export const DEFAULT_TTL_MS = 90_000;
export const DEFAULT_MAX_ENTRIES = 200;

export class ReadCache {
  readonly ttlMs: number;
  readonly maxEntries: number;
  private readonly now: () => number;
  private readonly entries = new Map<string, Entry<unknown>>();
  private readonly inflight = new Map<string, Promise<unknown>>();
  private counters = { hits: 0, misses: 0, refreshes: 0, staleServes: 0, errors: 0, evictions: 0 };

  constructor(options: ReadCacheOptions = {}) {
    this.ttlMs = clamp(options.ttlMs ?? DEFAULT_TTL_MS, MIN_TTL_MS, MAX_TTL_MS);
    this.maxEntries = Math.max(1, options.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.now = options.now ?? (() => Date.now());
  }

  /**
   * Fetch through the cache.
   *
   * `refresh: true` skips the stored entry and performs a real read. If that read fails
   * and a previous value exists, the previous value is returned marked `stale` with the
   * error attached — the operator sees the last known good figures AND the fact that the
   * refresh failed, which is more useful than either alone.
   */
  async get<T>(
    parts: CacheKeyParts,
    load: () => Promise<T>,
    options: { refresh?: boolean } = {},
  ): Promise<CacheResult<T>> {
    const key = buildCacheKey(parts);
    const existing = this.entries.get(key) as Entry<T> | undefined;
    const now = this.now();

    if (!options.refresh && existing && now < existing.expiresAt) {
      existing.lastAccess = now;
      this.counters.hits++;
      return this.result(key, existing, 'HIT', false, null);
    }

    try {
      const value = await this.load(key, load, options.refresh === true);
      const stored = this.store(key, value);
      if (options.refresh) this.counters.refreshes++; else this.counters.misses++;
      return this.result(key, stored, options.refresh ? 'REFRESH' : 'MISS', false, null);
    } catch (error) {
      this.counters.errors++;
      // Rule 4: a failure must not destroy or replace what we already had.
      if (existing) {
        this.counters.staleServes++;
        existing.lastAccess = this.now();
        return this.result(key, existing, 'HIT', true, toError(error));
      }
      throw error;
    }
  }

  /**
   * Single-flight: concurrent readers of the same key share one round trip. A refresh
   * always starts its own load, so "Refresh" can never be answered by a request that
   * began before the user asked for it.
   */
  private async load<T>(key: string, load: () => Promise<T>, refresh: boolean): Promise<T> {
    if (!refresh) {
      const pending = this.inflight.get(key) as Promise<T> | undefined;
      if (pending) return pending;
    }
    const promise = load().finally(() => {
      if (this.inflight.get(key) === promise) this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  private store<T>(key: string, value: T): Entry<T> {
    const now = this.now();
    const entry: Entry<T> = { value, storedAt: now, expiresAt: now + this.ttlMs, lastAccess: now };
    this.entries.set(key, entry as Entry<unknown>);
    this.evictIfNeeded();
    return entry;
  }

  private result<T>(key: string, entry: Entry<T>, outcome: CacheOutcome, stale: boolean, error: Error | null): CacheResult<T> {
    const now = this.now();
    return {
      value: entry.value,
      key,
      outcome,
      storedAt: new Date(entry.storedAt),
      ageMs: Math.max(0, now - entry.storedAt),
      stale: stale || now >= entry.expiresAt,
      error,
    };
  }

  /** Bounded size — least-recently-used goes first. */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxEntries) {
      let oldestKey: string | null = null;
      let oldestAccess = Infinity;
      for (const [key, entry] of this.entries) {
        if (entry.lastAccess < oldestAccess) { oldestAccess = entry.lastAccess; oldestKey = key; }
      }
      if (oldestKey === null) break;
      this.entries.delete(oldestKey);
      this.counters.evictions++;
    }
  }

  /** Drop every entry whose key starts with `prefix` (a resource name, usually). */
  invalidate(prefix: string): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.startsWith(prefix)) { this.entries.delete(key); removed++; }
    }
    return removed;
  }

  /** Drop everything cached for one investor. Used when an account is unlinked. */
  invalidateIdentity(identity: string): number {
    let removed = 0;
    for (const key of [...this.entries.keys()]) {
      if (key.includes(`|identity=${identity}|`)) { this.entries.delete(key); removed++; }
    }
    return removed;
  }

  clear(): void {
    this.entries.clear();
    this.inflight.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  stats() {
    return { ...this.counters, size: this.entries.size, ttlMs: this.ttlMs, maxEntries: this.maxEntries };
  }

  /** Test/diagnostic seam: is this key currently cached and unexpired? */
  peek(parts: CacheKeyParts): { storedAt: Date; expired: boolean } | null {
    const entry = this.entries.get(buildCacheKey(parts));
    if (!entry) return null;
    return { storedAt: new Date(entry.storedAt), expired: this.now() >= entry.expiresAt };
  }
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return DEFAULT_TTL_MS;
  return Math.min(max, Math.max(min, value));
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/** TTL from the environment, clamped. Exported so the runbook and tests agree on it. */
export function configuredTtlMs(env: EnvLike = process.env): number {
  const raw = Number(env.SHEETS_CACHE_TTL_SECONDS);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_TTL_MS;
  return clamp(raw * 1000, MIN_TTL_MS, MAX_TTL_MS);
}
