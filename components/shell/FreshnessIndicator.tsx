'use client';
/**
 * FRESHNESS INDICATOR — how old the numbers are, and whether the source is reachable.
 *
 * One job, and it is a job about honesty: **never use the word "Live" once the most recent
 * successful fetch has gone stale, or once a fetch has failed.** A stale figure labelled
 * live is a decision made on the wrong number.
 *
 * Staleness is evaluated twice — the server reports it at fetch time, and the client
 * re-evaluates on a timer — so a tab left open overnight cannot keep claiming to be
 * current.
 *
 * Which environment and which workbook these figures came from is stated by
 * `EnvironmentStatus`, which wraps this component. This one only answers "how fresh".
 */
import { useEffect, useState } from 'react';
import type { DataMeta, FreshnessState } from '@/lib/data/providers/types';
import { formatRelativeTime, freshnessFromTimestamp } from '@/lib/shared/format';

const RANK: Record<FreshnessState, number> = { GOOD: 0, STALE: 1, ERROR: 2 };

/** The more pessimistic of the two assessments always wins. */
function worst(a: FreshnessState, b: FreshnessState): FreshnessState {
  return RANK[a] >= RANK[b] ? a : b;
}

export function FreshnessIndicator({ meta }: { meta: DataMeta }) {
  // Rendered on a timer so "2 minutes ago" does not silently become an hour old.
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(timer);
  }, []);

  const lastSync = meta.lastSuccessfulSyncAt ?? meta.asOf;
  const observed: FreshnessState = now ? freshnessFromTimestamp(lastSync, now) : 'GOOD';
  const state = worst(meta.freshness, observed);
  const relative = now ? formatRelativeTime(lastSync, now) : 'Loading…';

  /*
   * Demo data is generated per request, so it is always current — saying "Live" about
   * fictional figures would be the wrong word, and the DEMO / UAT badge beside it already
   * says what it is. Live data earns the word only when the last fetch succeeded.
   */
  const label = state === 'ERROR' ? 'Source unavailable'
    : state === 'STALE' ? `Stale · last synced ${relative}`
      : meta.demo ? relative
        : `Live · ${relative}`;

  const detail = state === 'ERROR'
    ? (meta.lastSuccessfulSyncAt ? `Showing last good data from ${relative}` : 'No data has been loaded')
    : null;

  return (
    <span className="sv-freshness">
      <span
        className={`sv-freshness__state sv-freshness__state--${state.toLowerCase()}`}
        title={meta.error ?? undefined}
      >
        <span className="sv-freshness__dot" aria-hidden="true" />
        <span>{label}</span>
      </span>
      {detail ? <span className="sv-freshness__detail">{detail}</span> : null}
    </span>
  );
}
