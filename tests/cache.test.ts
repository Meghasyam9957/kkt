/**
 * READ CACHE SUITE.
 *
 * Each block maps to one of the five rules the cache exists to enforce. They are written
 * as failure scenarios rather than API exercises, because the risk being managed is not
 * "the cache is slow" — it is "an operator acts on a stale figure believing it current",
 * or "one investor is served another investor's numbers".
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ReadCache, buildCacheKey, configuredTtlMs, CacheIdentityError,
  IDENTITY_SCOPED_RESOURCES, MIN_TTL_MS, MAX_TTL_MS, DEFAULT_TTL_MS,
} from '@/lib/server/cache/read-cache';

/** Controllable clock, so TTL expiry is asserted rather than waited for. */
function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

let time: ReturnType<typeof clock>;
let cache: ReadCache;

beforeEach(() => {
  time = clock();
  cache = new ReadCache({ ttlMs: 60_000, maxEntries: 5, now: time.now });
});

/* ================================================================== *
 * 1 · Bounded TTL
 * ================================================================== */

describe('cache · rule 1: the TTL is bounded', () => {
  it('serves from cache inside the TTL and re-reads after it', async () => {
    let reads = 0;
    const load = async () => { reads++; return { value: reads }; };
    const key = { resource: 'workbook', identity: null };

    expect((await cache.get(key, load)).outcome).toBe('MISS');
    expect((await cache.get(key, load)).outcome).toBe('HIT');
    expect(reads).toBe(1);

    time.advance(60_001);
    expect((await cache.get(key, load)).outcome).toBe('MISS');
    expect(reads).toBe(2);
  });

  it('clamps an absurd configured TTL rather than honouring it', () => {
    expect(new ReadCache({ ttlMs: 1 }).ttlMs).toBe(MIN_TTL_MS);
    expect(new ReadCache({ ttlMs: 999_999_999 }).ttlMs).toBe(MAX_TTL_MS);
    // A typo cannot produce a cache that never expires — that is the whole point.
    expect(new ReadCache({ ttlMs: Number.NaN }).ttlMs).toBe(DEFAULT_TTL_MS);
  });

  it('reads the TTL from the environment, still clamped', () => {
    expect(configuredTtlMs({ SHEETS_CACHE_TTL_SECONDS: '90' })).toBe(90_000);
    expect(configuredTtlMs({ SHEETS_CACHE_TTL_SECONDS: '99999' })).toBe(MAX_TTL_MS);
    expect(configuredTtlMs({ SHEETS_CACHE_TTL_SECONDS: 'nonsense' })).toBe(DEFAULT_TTL_MS);
    expect(configuredTtlMs({})).toBe(DEFAULT_TTL_MS);
  });

  it('is bounded in size as well as in time', async () => {
    for (let i = 0; i < 12; i++) {
      await cache.get({ resource: 'r', identity: null, filters: { i } }, async () => i);
    }
    expect(cache.size).toBeLessThanOrEqual(5);
    expect(cache.stats().evictions).toBeGreaterThan(0);
  });
});

/* ================================================================== *
 * 2 · An explicit refresh is always a real read
 * ================================================================== */

describe('cache · rule 2: refresh is never answered from cache', () => {
  it('bypasses a perfectly fresh entry', async () => {
    let reads = 0;
    const load = async () => ++reads;
    const key = { resource: 'workbook', identity: null };

    await cache.get(key, load);
    const refreshed = await cache.get(key, load, { refresh: true });

    expect(refreshed.outcome).toBe('REFRESH');
    expect(refreshed.value).toBe(2);
    expect(refreshed.stale).toBe(false);
  });

  it('a refresh does not join a read that started before it was requested', async () => {
    // Otherwise "Refresh" could be satisfied by a request already in flight, returning
    // data fetched before the user asked for anything new.
    let reads = 0;
    const gate: Array<() => void> = [];
    const load = () => new Promise<number>((resolve) => {
      const n = ++reads;
      gate.push(() => resolve(n));
    });
    const key = { resource: 'workbook', identity: null };

    const first = cache.get(key, load);
    const refresh = cache.get(key, load, { refresh: true });
    expect(reads).toBe(2);                       // two genuine reads, not one shared

    gate.forEach((release) => release());
    await Promise.all([first, refresh]);
  });

  it('concurrent ordinary readers share one round trip', async () => {
    let reads = 0;
    const load = async () => { reads++; await Promise.resolve(); return reads; };
    const key = { resource: 'workbook', identity: null };

    await Promise.all([cache.get(key, load), cache.get(key, load), cache.get(key, load)]);
    expect(reads).toBe(1);
  });
});

/* ================================================================== *
 * 3 · The key includes the filters
 * ================================================================== */

describe('cache · rule 3: filters are part of the key', () => {
  it('different months are different entries', async () => {
    const months: string[] = [];
    const load = (month: string) => async () => { months.push(month); return month; };

    await cache.get({ resource: 'dashboard', identity: null, filters: { month: '2026-04' } }, load('2026-04'));
    await cache.get({ resource: 'dashboard', identity: null, filters: { month: '2026-05' } }, load('2026-05'));
    await cache.get({ resource: 'dashboard', identity: null, filters: { month: '2026-04' } }, load('2026-04'));

    expect(months).toEqual(['2026-04', '2026-05']);   // the third call was a hit
  });

  it('property and platform filters change the key too', () => {
    const base = { resource: 'dashboard', identity: null, filters: { month: '2026-04' } };
    const a = buildCacheKey(base);
    const b = buildCacheKey({ ...base, filters: { month: '2026-04', propertyId: 'HYD-501' } });
    const c = buildCacheKey({ ...base, filters: { month: '2026-04', platform: 'Airbnb' } });
    expect(new Set([a, b, c]).size).toBe(3);
  });

  it('key building is order-independent, so equivalent filters share an entry', () => {
    expect(buildCacheKey({ resource: 'x', identity: null, filters: { a: 1, b: 2 } }))
      .toBe(buildCacheKey({ resource: 'x', identity: null, filters: { b: 2, a: 1 } }));
  });

  it('absent and empty filters are treated the same', () => {
    expect(buildCacheKey({ resource: 'x', identity: null, filters: { month: '2026-04', propertyId: null } }))
      .toBe(buildCacheKey({ resource: 'x', identity: null, filters: { month: '2026-04' } }));
  });
});

/* ================================================================== *
 * 4 · A failure never overwrites good data
 * ================================================================== */

describe('cache · rule 4: errors do not destroy cached data', () => {
  it('serves the last good value, marked stale, with the error attached', async () => {
    const key = { resource: 'workbook', identity: null };
    await cache.get(key, async () => 'good');

    time.advance(60_001);                          // entry has expired
    const result = await cache.get(key, async () => { throw new Error('sheets 503'); });

    expect(result.value).toBe('good');
    expect(result.stale).toBe(true);
    expect(result.error?.message).toContain('503');
  });

  it('a failed refresh leaves the previous value intact for the next reader', async () => {
    const key = { resource: 'workbook', identity: null };
    await cache.get(key, async () => 'good');

    await cache.get(key, async () => { throw new Error('boom'); }, { refresh: true });

    const after = await cache.get(key, async () => 'never called');
    expect(after.value).toBe('good');
    expect(after.error).toBeNull();
  });

  it('throws when there is nothing cached to fall back to', async () => {
    // No data at all is an outage. Inventing something to show would be worse.
    await expect(cache.get({ resource: 'workbook', identity: null }, async () => {
      throw new Error('sheets unreachable');
    })).rejects.toThrow('sheets unreachable');
  });

  it('counts stale serves so the condition is visible in diagnostics', async () => {
    const key = { resource: 'workbook', identity: null };
    await cache.get(key, async () => 1);
    time.advance(60_001);
    await cache.get(key, async () => { throw new Error('down'); });
    expect(cache.stats().staleServes).toBe(1);
    expect(cache.stats().errors).toBe(1);
  });
});

/* ================================================================== *
 * 5 · Investor data is never shared across identities
 * ================================================================== */

describe('cache · rule 5: no investor data crosses identities', () => {
  it('two investors reading the same resource get their own entries', async () => {
    const loads: string[] = [];
    const load = (id: string) => async () => { loads.push(id); return `figures for ${id}`; };

    const a = await cache.get({ resource: 'investor.overview', identity: 'INV-001' }, load('INV-001'));
    const b = await cache.get({ resource: 'investor.overview', identity: 'INV-002' }, load('INV-002'));

    expect(a.value).toBe('figures for INV-001');
    expect(b.value).toBe('figures for INV-002');
    expect(loads).toEqual(['INV-001', 'INV-002']);   // INV-002 did NOT get a cache hit
  });

  it('an investor-scoped resource cannot be cached without an identity', () => {
    for (const resource of IDENTITY_SCOPED_RESOURCES) {
      expect(() => buildCacheKey({ resource, identity: null }), resource)
        .toThrow(CacheIdentityError);
    }
  });

  it('a management-wide resource may legitimately have no identity', () => {
    expect(() => buildCacheKey({ resource: 'workbook', identity: null })).not.toThrow();
  });

  it('identity appears in the key even for unscoped resources, so it can never collide', () => {
    expect(buildCacheKey({ resource: 'x', identity: 'INV-001' }))
      .not.toBe(buildCacheKey({ resource: 'x', identity: 'INV-002' }));
  });

  it('one investor can be evicted without touching another', async () => {
    await cache.get({ resource: 'investor.overview', identity: 'INV-001' }, async () => 'a');
    await cache.get({ resource: 'investor.overview', identity: 'INV-002' }, async () => 'b');

    expect(cache.invalidateIdentity('INV-001')).toBe(1);
    expect(cache.peek({ resource: 'investor.overview', identity: 'INV-001' })).toBeNull();
    expect(cache.peek({ resource: 'investor.overview', identity: 'INV-002' })).not.toBeNull();
  });
});

/* ================================================================== *
 * Invalidation surface
 * ================================================================== */

describe('cache · invalidation', () => {
  it('drops everything under a resource prefix', async () => {
    await cache.get({ resource: 'dashboard', identity: null, filters: { month: '2026-04' } }, async () => 1);
    await cache.get({ resource: 'dashboard', identity: null, filters: { month: '2026-05' } }, async () => 2);
    await cache.get({ resource: 'workbook', identity: null }, async () => 3);

    expect(cache.invalidate('dashboard')).toBe(2);
    expect(cache.peek({ resource: 'workbook', identity: null })).not.toBeNull();
  });

  it('clear empties the cache completely', async () => {
    await cache.get({ resource: 'workbook', identity: null }, async () => 1);
    cache.clear();
    expect(cache.size).toBe(0);
  });
});
