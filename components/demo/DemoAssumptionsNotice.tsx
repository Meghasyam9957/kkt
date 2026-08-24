import '@/lib/server/only';
/**
 * DEMO FINANCIAL ASSUMPTIONS NOTICE.
 *
 * Wherever a demonstration shows money that depends on the commercial terms, this says
 * plainly that those terms are illustrative. Without it, a client reading a distribution
 * figure has every reason to believe it reflects an agreement — and it does not.
 *
 * It renders **only in demo**. In production the function returns null before it looks at
 * anything else, so there is no configuration under which a production deployment could
 * display it. That is the same rule as the DEMO / UAT badge, applied to the one place
 * where getting it wrong would cost money rather than credibility.
 *
 * The percentages are read from the demo dataset rather than typed here, so the notice and
 * the arithmetic behind the figures cannot drift apart.
 */
import { resolveEnvironment } from '@/lib/server/environment/config';
import { DEMO_SAMPLE_BUSINESS_RULES } from '@/lib/data/demo/dataset';

const pct = (value: number | null): string =>
  value === null ? 'not set' : `${(value * 100).toFixed(value * 100 % 1 === 0 ? 0 : 1)}%`;

export function DemoAssumptionsNotice({ scope = 'financial' }: {
  /** 'investor' spells out the consequence for someone reading their own distribution. */
  scope?: 'financial' | 'investor';
}) {
  if (resolveEnvironment().env !== 'demo') return null;

  const rules = DEMO_SAMPLE_BUSINESS_RULES;

  return (
    <aside className="sv-demo-notice" role="note" aria-label="Demonstration financial assumptions">
      <div>
        <p className="sv-demo-notice__title">
          Demo financial assumptions — not production terms
        </p>
        <p className="sv-demo-notice__body">
          {scope === 'investor'
            ? 'The figures below are calculated from illustrative commercial terms so the '
              + 'distribution can be demonstrated end to end. Management has approved no terms; '
              + 'nothing here represents an agreement or an entitlement.'
            : 'Any figure that depends on the commercial terms is calculated from illustrative '
              + 'values. Management has approved no terms, and production leaves them unset.'}
        </p>
        <dl className="sv-demo-notice__rules">
          <li><dt>Investor pool</dt><dd>{pct(rules.investorPoolPct)}</dd></li>
          <li><dt>Operator pool</dt><dd>{pct(rules.operatorPoolPct)}</dd></li>
          <li><dt>Reserve</dt><dd>{pct(rules.reservePct)}</dd></li>
        </dl>
      </div>
    </aside>
  );
}
