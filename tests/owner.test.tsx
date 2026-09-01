/**
 * UI-9 — THE INVESTOR'S OWN SCREEN, and the owner model that does not exist.
 *
 * UI-9 asked for a per-property owner experience. The first block here is the PROOF that
 * one cannot be built: there is no ownership relation in either direction, an investor's
 * `ParticipationPct` is a share within a POOL, and the property master describes units the
 * business LEASES. Those facts are asserted against the generated contract and the domain
 * rather than argued in a comment, so nobody has to re-derive them — and so that adding
 * ownership later fails these tests loudly instead of drifting in.
 *
 * The rest holds the lines the investor surface already stood on, now that the screen has
 * more on it: portfolio level only, no guest, no cost detail, no other investor, nothing
 * resolved from anything but the session, and unset rules stated rather than filled in.
 */
import { describe, it, expect } from 'vitest';
import { COLUMNS } from '@/lib/contract/contract.generated';
import { InvestorService, INVESTOR_FORBIDDEN_FIELDS } from '@/lib/server/api/investor-service';
import { roleHasCapability, ROLES, FINANCIAL_CAPABILITIES } from '@/lib/shared/roles';
import { NAVIGATION } from '@/lib/shared/navigation';
import { distributionsMixed } from './fixtures/scenarios';
import { readSource as read, codeOf } from './support/source';

const PAGE = 'app/admin/portfolio/page.tsx';
const data = distributionsMixed().data;
const service = () => new InvestorService(data);
const keysOf = (sheet: 'INVESTORS' | 'PROPERTIES') => COLUMNS[sheet]!.map((c) => c.key);

/* ================================================================== *
 * 1 · THERE IS NO OWNER, AND NO PROPERTY TO OWN
 * ================================================================== */

describe('owner · the model that does not exist', () => {
  it('has no ownership relation between an investor and a property, in either direction', () => {
    // Nothing on the investor points at a unit…
    for (const key of keysOf('INVESTORS')) {
      expect(key, `10_INVESTORS.${key} looks like an ownership link`)
        .not.toMatch(/property|unit|owns/i);
    }
    // …and nothing on the unit points at an investor or an owner.
    for (const key of keysOf('PROPERTIES')) {
      expect(key, `03_PROPERTIES.${key} looks like an ownership link`)
        .not.toMatch(/investor|owner/i);
    }
  });

  it('models a business that LEASES its units, from a landlord who is not a user', () => {
    const property = keysOf('PROPERTIES');
    // The lease is the relationship the property master actually carries.
    for (const key of ['MonthlyRent', 'SecurityDeposit', 'LeaseStart', 'LeaseEnd', 'Landlord']) {
      expect(property, key).toContain(key);
    }
    // And a landlord is free text — no id, no role, no login, no position.
    expect(COLUMNS.PROPERTIES!.find((c) => c.key === 'Landlord')!.type).toBe('text');
    expect(ROLES).not.toContain('OWNER');
    expect(ROLES).not.toContain('LANDLORD');
  });

  it('gives an investor a share of the POOL, which is why no figure is per-property', () => {
    const participation = COLUMNS.INVESTORS!.find((c) => c.key === 'ParticipationPct')!;
    // The contract says it in as many words, and the note is the reason for the whole
    // portfolio-only scope. If it ever changes, this is where that surfaces.
    expect(participation.note).toMatch(/within the investor pool/i);

    const overview = service().overview('INV-001', '2026-04');
    const payload = JSON.stringify(overview);
    // No unit id, and no per-property anything, reaches an investor.
    expect(payload).not.toMatch(/HYD-\d{3}/);
    expect(payload).not.toMatch(/propertyId|properties|byProperty|perProperty/i);
    expect(Object.keys(overview.portfolio)).toEqual([
      'monthKey', 'netRevenue', 'operatingProfit', 'occupancyPct',
      'distributableProfit', 'configured',
    ]);
  });

  it('says on the screen that the figures are the whole business, not a unit', () => {
    const src = read(PAGE);
    expect(src).toMatch(/not a single property/i);
    expect(src).toContain('docs/UI9_OWNER_DECISIONS.md');
  });
});

/* ================================================================== *
 * 2 · ISOLATION — resolved on the server, twice
 * ================================================================== */

describe('owner · isolation', () => {
  it('resolves the investor from the SESSION, never from the request', () => {
    const src = codeOf(read(PAGE));
    expect(src).toContain('access.session.investorId');
    /*
     * The page takes no props at all — no searchParams, no params, no headers. There is
     * no channel through which another investor's id could arrive, which is a stronger
     * guarantee than validating one.
     */
    expect(src).toMatch(/export default async function PortfolioPage\(\)/);
    expect(src).not.toMatch(/searchParams|useSearchParams|params\.|localStorage|cookies\(\)/);
  });

  it('refuses a caller with the capability but no scope, rather than showing everything', () => {
    const src = codeOf(read(PAGE));
    expect(src).toContain('if (!investorId)');
    // And the service refuses independently of the page.
    expect(() => service().overview('', '2026-04')).toThrow(/requires a server-resolved investor id/i);
    expect(() => service().distributions('', ['2026-04'])).toThrow();
  });

  it('returns one investor\'s distribution and never another\'s', () => {
    const mine = service().distributions('INV-001', ['2026-04']);
    expect(mine.length).toBeGreaterThan(0);
    expect(JSON.stringify(mine)).not.toContain('INV-002');

    const theirs = service().distributions('INV-002', ['2026-04']);
    expect(JSON.stringify(theirs)).not.toContain('INV-001');
    // Two investors, two different answers — not one shared list.
    expect(mine).not.toEqual(theirs);
  });

  it('is not SENT the property directory either, not merely stopped from showing it', () => {
    /*
     * The shell fetched the filter vocabulary for every role and handed it to a client
     * component, so every unit id and unit name was serialised into the investor's page
     * payload — invisible on screen and present in their browser. Nothing rendered it;
     * that is not the same as not sending it.
     */
    const layout = codeOf(read('app/admin/layout.tsx'));
    expect(layout).toContain("roleHasCapability(session.role, 'properties.read')");
    expect(layout).toMatch(/mayFilter \? provider\.getPropertyDirectory\(\)/);
    expect(layout).toMatch(/mayFilter \? provider\.getAvailableMonths\(\)/);
    // And the investor may not read properties, so the arrays arrive empty.
    expect(roleHasCapability('INVESTOR', 'properties.read')).toBe(false);
  });

  it('is the only screen the role can reach, and management screens are not in its menu', () => {
    expect(read(PAGE)).toContain("checkPageAccess('investor.self.read')");
    expect(roleHasCapability('INVESTOR', 'investor.self.read')).toBe(true);

    const visible = NAVIGATION.flatMap((s) => s.items)
      .filter((i) => roleHasCapability('INVESTOR', i.capability));
    expect(visible.map((i) => i.href)).toEqual(['/admin/portfolio']);
  });
});

/* ================================================================== *
 * 3 · WHAT THE SCREEN MAY SHOW
 * ================================================================== */

describe('owner · disclosure', () => {
  it('shows occupancy, revenue and the operating result — and never the costs behind them', () => {
    const overview = service().overview('INV-001', '2026-04');
    expect(overview.portfolio).toHaveProperty('netRevenue');
    expect(overview.portfolio).toHaveProperty('operatingProfit');
    expect(overview.portfolio).toHaveProperty('occupancyPct');
    // Operating profit is approved; the expenses it was computed from are not.
    expect(overview.portfolio).not.toHaveProperty('operatingExpenses');

    const payload = JSON.stringify({
      overview,
      performance: service().performance('INV-001'),
      distributions: service().distributions('INV-001', ['2026-04']),
    });
    for (const field of INVESTOR_FORBIDDEN_FIELDS) {
      expect(payload, `leaked ${field}`).not.toContain(`"${field}"`);
    }
    expect(payload.toLowerCase()).not.toContain('guest');
    expect(payload.toLowerCase()).not.toContain('vendor');
  });

  it('carries no booking, no unit state and no operational detail', () => {
    const payload = JSON.stringify(service().performance('INV-001'));
    for (const term of ['BK-', 'bookingId', 'checkIn', 'housekeeping', 'maintenance', 'turnover']) {
      expect(payload, term).not.toContain(term);
    }
    const src = codeOf(read(PAGE));
    expect(src).not.toMatch(/getOperations|getReservations|getCalendar|getAvailability|BookingDetail/);
  });

  it('offers no forecast, because that capability is management\'s', () => {
    // Not an oversight — a decision. The investor holds no analytics capability, so
    // putting a forecast here would WIDEN one. Recorded in UI9_OWNER_DECISIONS.md.
    expect(roleHasCapability('INVESTOR', 'analytics.read')).toBe(false);
    const src = codeOf(read(PAGE));
    expect(src).not.toMatch(/forecast|getForecast/i);
  });

  it('holds no financial capability at all, so no management money screen is reachable', () => {
    for (const capability of FINANCIAL_CAPABILITIES) {
      expect(roleHasCapability('INVESTOR', capability), capability).toBe(false);
    }
  });
});

/* ================================================================== *
 * 4 · WHAT IT MAY NOT PRETEND
 * ================================================================== */

describe('owner · unset rules are stated, never filled in', () => {
  it('computes nothing in the page — every figure is server-derived', () => {
    const src = codeOf(read(PAGE));
    /*
     * No arithmetic on money or percentages. A trend or a projection assembled here would
     * be a second engine, and the one place a figure can be wrong without the workbook
     * disagreeing with it.
     */
    expect(src).not.toMatch(/[-+*/]\s*100\b|reduce\(|Math\.(round|max|min)\(/);
    expect(src).not.toMatch(/netRevenue\s*[-+*/]|operatingProfit\s*[-+*/]/);
  });

  it('says CONFIGURATION REQUIRED rather than showing a zero that reads as a position', () => {
    const src = read(PAGE);
    expect(src).toContain('Configuration required');
    expect(src).toMatch(/it is a decision that has not been made/);
    // The unconfigured distributable profit is words, not ₹0.
    expect(src).toContain("'Not yet calculable'");
  });

  it('offers no statement, and names BOTH reasons one cannot be produced', () => {
    const src = read(PAGE);
    expect(src).toMatch(/No statements are available yet/);
    expect(src).toMatch(/distribution terms have not been approved/);
    expect(src).toMatch(/no period has been closed/);

    /*
     * The second reason is real and checkable: `InvestorService.reports` takes the
     * approved months from its caller, and nothing anywhere supplies them, because
     * 18_MONTHLY_CLOSE has no repository.
     */
    expect(codeOf(read('lib/server/sheets/repositories/index.ts'))).not.toMatch(/CLOSE'/);
  });

  it('speaks to a person, never in technical language', () => {
    const src = read(PAGE);
    for (const leak of ['InvestorService', 'workbook.', 'monthKey}', 'Error', '/api/']) {
      // The rendered strings, not the imports: split on the JSX text the reader sees.
      const rendered = src.match(/(title|message|subtitle|description)=\{?["'`][^"'`]+/g) ?? [];
      for (const text of rendered) {
        expect(text, `${leak} in "${text.slice(0, 60)}"`).not.toContain(leak);
      }
    }
  });
});

/* ================================================================== *
 * 5 · THE SHAPE OF THE SCREEN
 * ================================================================== */

describe('owner · the experience', () => {
  it('leads with the position, then the business, then the shape of it', () => {
    const src = read(PAGE);
    const order = ['Your position', 'The portfolio in ', 'How the portfolio has traded',
      'Your distribution', 'Statements'];
    let cursor = -1;
    for (const section of order) {
      const at = src.indexOf(section);
      expect(at, `${section} is missing`).toBeGreaterThan(-1);
      expect(at, `${section} is out of order`).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('shows the trend as a chart, which carries its own tabular equivalent', () => {
    const src = read(PAGE);
    expect(src).toContain('RevenueTrendChart');
    expect(src).toContain('OccupancyTrendChart');
    // The chart component hides the drawing from assistive technology and renders a table
    // beside it, so no figure is ever carried by the picture alone.
    const charts = read('components/charts/Charts.tsx');
    expect(charts).toContain('ChartTable');
    expect(charts).toMatch(/aria-hidden/);
  });

  it('gives a phone records rather than a four-column finance table', () => {
    const src = read(PAGE);
    // Both tables on this screen stack; the brief's rule is no dense finance table on a
    // phone, and a stacked record is not one.
    expect(src.match(/mobile="stack"/g) ?? []).toHaveLength(2);
  });

  it('reveals with the shared motion system, which already respects reduced motion', () => {
    const src = read(PAGE);
    expect(src).toMatch(/m-stagger|m-reveal/);
    expect(read('styles/motion.css')).toMatch(/prefers-reduced-motion/);
  });
});
