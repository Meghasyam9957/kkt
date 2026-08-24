/**
 * ActivityLog — what happened to an entity, in order, with provenance.
 *
 * Presentational: entries arrive prepared (already redacted, already formatted). This is
 * the per-record face of the audit trail — "Recorded via web · Demo Administrator ·
 * 4 minutes ago" — never a raw audit dump.
 */
export interface ActivityEntry {
  id: string;
  /** "Recorded", "Amended", "Checked in", "Denied". */
  action: string;
  /** Who — display name, already minimised where required. */
  actor: string;
  /** Already formatted relative or absolute time. */
  when: string;
  detail?: string;
  /** ALLOW renders quietly; DENY and ERROR are visually distinct. */
  result?: 'ALLOW' | 'DENY' | 'ERROR';
  operationId?: string;
}

export function ActivityLog({ entries, label }: { entries: ActivityEntry[]; label: string }) {
  if (entries.length === 0) {
    return <p className="sv-activity__empty">No recorded activity yet.</p>;
  }
  return (
    <ol className="sv-activity" aria-label={label}>
      {entries.map((entry) => (
        <li
          key={entry.id}
          className={`sv-activity__entry ${entry.result && entry.result !== 'ALLOW' ? 'sv-activity__entry--denied' : ''}`}
        >
          <p className="sv-activity__line">
            <span className="sv-activity__action">{entry.action}</span>
            {' · '}
            <span className="sv-activity__actor">{entry.actor}</span>
            {' · '}
            <span className="sv-activity__when">{entry.when}</span>
          </p>
          {entry.detail ? <p className="sv-activity__detail">{entry.detail}</p> : null}
          {entry.operationId ? <p className="sv-activity__meta">Operation {entry.operationId}</p> : null}
        </li>
      ))}
    </ol>
  );
}
