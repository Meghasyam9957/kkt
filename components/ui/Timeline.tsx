/**
 * Timeline — the operations daybook's spine, and any other time-ordered record.
 *
 * Presentational only: it receives prepared stops and renders them; it never sorts,
 * filters or derives. Status tone maps to the semantic palette through StatusPill, so
 * colour keeps one meaning and every stop carries its words.
 */
import type { ReactNode } from 'react';
import { StatusPill, type Tone } from './primitives';

export interface TimelineStop {
  /** Stable key. */
  id: string;
  /** Left column: "11:00", "By 2 PM", "Morning". Already formatted by the caller. */
  time: string;
  title: string;
  detail?: string;
  status?: { tone: Tone; label: string };
  /** Quick action(s) — buttons/links supplied by the caller. */
  action?: ReactNode;
  /** Marks the stop visually urgent (position already conveys order). */
  urgent?: boolean;
}

export function Timeline({ stops, label }: { stops: TimelineStop[]; label: string }) {
  return (
    <ol className="sv-timeline" aria-label={label}>
      {stops.map((stop) => (
        <li key={stop.id} className={`sv-timeline__stop ${stop.urgent ? 'sv-timeline__stop--urgent' : ''}`}>
          <span className="sv-timeline__time numeric">{stop.time}</span>
          <span className="sv-timeline__dot" aria-hidden="true" />
          <div className="sv-timeline__body">
            <div className="sv-timeline__head">
              <p className="sv-timeline__title">{stop.title}</p>
              {stop.status ? <StatusPill tone={stop.status.tone}>{stop.status.label}</StatusPill> : null}
            </div>
            {stop.detail ? <p className="sv-timeline__detail">{stop.detail}</p> : null}
            {stop.action ? <div className="sv-timeline__action">{stop.action}</div> : null}
          </div>
        </li>
      ))}
    </ol>
  );
}
