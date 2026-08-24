'use client';
/**
 * ENVIRONMENT + DATA SOURCE STATUS.
 *
 * Answers three questions on every internal page, because a person looking at a figure
 * needs all three before they can act on it: **which system am I in**, **where did this
 * number come from**, and **how old is it**.
 *
 * The DEMO / UAT badge appears when — and only when — the server resolved this deployment
 * as demo. Production has no banner text to render, so a production build cannot display
 * one even if this component were asked to. The client never decides which environment it
 * is in; it renders what the server resolved.
 */
import type { PublicEnvironmentInfo } from '@/lib/shared/environment';
import type { DataMeta } from '@/lib/data/providers/types';
import { FreshnessIndicator } from './FreshnessIndicator';

export function EnvironmentStatus({ environment, meta }: {
  environment: PublicEnvironmentInfo;
  meta: DataMeta;
}) {
  return (
    <div className="sv-envstatus">
      {environment.banner ? (
        <span
          className="sv-demo-badge"
          title="Fictional demonstration data — not business data"
        >
          {environment.banner}
        </span>
      ) : null}

      <dl className="sv-envstatus__facts">
        <div className="sv-envstatus__fact sv-envstatus__fact--env">
          <dt>Environment</dt>
          <dd className={`sv-envstatus__env sv-envstatus__env--${environment.env}`}>
            {environment.name}
          </dd>
        </div>
        <div className="sv-envstatus__fact sv-envstatus__fact--source">
          <dt>Data source</dt>
          <dd>{environment.dataSourceLabel}</dd>
        </div>
        <div className="sv-envstatus__fact">
          <dt>Last synced</dt>
          <dd><FreshnessIndicator meta={meta} /></dd>
        </div>
      </dl>
    </div>
  );
}
