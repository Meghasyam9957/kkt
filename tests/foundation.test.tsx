/**
 * VERANDAH LEDGER FOUNDATION (M-UI-1).
 *
 * The design system doc is the authority; these tests keep the built foundation honest
 * against it, the way the RBAC suite keeps the role table honest. Three kinds of check:
 *   - token/CSS contracts (the floor, the ladder, the reduced-motion kill switches),
 *     asserted against the stylesheet source because the rule IS the source;
 *   - component behaviour (button states, table modes, chart accessibility), asserted
 *     against rendered output;
 *   - vocabulary (no machinery language from shared components).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

import {
  Card, CardHeader, CardBody, Button, StatusPill, Tag, Chip,
} from '@/components/ui/primitives';
import { Stack, Cluster, Grid } from '@/components/ui/layout';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RevenueTrendChart, OccupancyTrendChart } from '@/components/charts/Charts';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const tokens = () => read('styles/tokens.css');
const app = () => read('styles/app.css');
const motion = () => read('styles/motion.css');

const codeOnly = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

beforeEach(() => cleanup());

/* ================================================================== *
 * 1 · The type floor
 * ================================================================== */

describe('typography · nothing readable below the 11px floor', () => {
  it('app.css declares no font-size below --text-label', () => {
    const source = codeOnly(app());
    // The 9px and 10px tiers are gone entirely, not merely unused.
    expect(source).not.toMatch(/font-size:\s*0\.5625rem/);
    expect(source).not.toMatch(/font-size:\s*0\.625rem/);
    // Pixel declarations: nothing under 11px anywhere in the product styles.
    for (const match of source.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
      expect(Number(match[1]), match[0]).toBeGreaterThanOrEqual(11);
    }
    // Rem declarations: the label token (0.6875rem = 11px) is the smallest.
    for (const match of source.matchAll(/font-size:\s*(0\.\d+)rem/g)) {
      expect(Number(match[1]), match[0]).toBeGreaterThanOrEqual(0.6875);
    }
  });

  it('the rem base is 16px, so the floor token really renders at 11px', () => {
    const source = codeOnly(app());
    // A shrunken root re-shrinks every rem token below its documented size — the old
    // 15px base rendered the "11px" floor at 10.31px.
    expect(source).toMatch(/html\s*{\s*font-size:\s*100%;\s*}/);
    expect(source).not.toMatch(/html[^{]*{[^}]*font-size:\s*15px/);
    expect(source).toMatch(/body\s*{[^}]*font-size:\s*var\(--t-body\)/);
  });

  it('the type roles exist as tokens, and the label role IS the floor', () => {
    const source = tokens();
    for (const role of ['--t-hero', '--t-h1', '--t-h2', '--t-kpi', '--t-body', '--t-small', '--t-label']) {
      expect(source, role).toContain(`${role}:`);
    }
    expect(source).toContain('--t-label: var(--text-label)');
    expect(source).toContain('--text-label: 0.6875rem');
  });

  it('chart labels are real 11px — the tick class reads the chart token', () => {
    expect(tokens()).toContain('--chart-label-size: 11px');
    expect(app()).toMatch(/\.sv-chart__tick\s*{\s*font-size:\s*var\(--chart-label-size\)/);
  });
});

/* ================================================================== *
 * 2 · Semantic colour — one meaning per hue, brand never carries status
 * ================================================================== */

describe('semantic colour', () => {
  it('the five status tones exist in light and dark', () => {
    const source = tokens();
    for (const tone of ['good', 'warn', 'bad', 'info', 'neutral']) {
      expect(source, tone).toContain(`--${tone}-fg`);
    }
    // Dark theme redefines the pairs (both the media query and the explicit override).
    expect((source.match(/--good-fg:\s*#7BD69B/g) ?? []).length).toBe(2);
  });

  it('no brand-coloured status pill exists any more', () => {
    expect(app()).not.toContain('sv-pill--brand');
    expect(app()).not.toContain('sv-badge--brand');
    expect(read('components/ui/primitives.tsx')).not.toMatch(/Tone =[^;]*'brand'/);
  });

  it('a status pill always carries its word — the dot alone is decorative', () => {
    render(<StatusPill tone="good">Available</StatusPill>);
    expect(screen.getByText('Available')).toBeDefined();
  });

  it('chart series are chart tokens with dark-theme values, never status colours', () => {
    const source = tokens();
    for (const token of ['--chart-1', '--chart-2', '--chart-3', '--chart-ref']) {
      // Defined twice for dark (media block + explicit data-theme) plus once for light.
      expect((source.match(new RegExp(`${token}:`, 'g')) ?? []).length, token).toBeGreaterThanOrEqual(3);
    }
    const charts = codeOnly(read('components/charts/Charts.tsx'));
    expect(charts).not.toMatch(/--good-fg|--warn-fg|--bad-fg|--info-fg/);
  });
});

/* ================================================================== *
 * 3 · Surfaces
 * ================================================================== */

describe('surface system', () => {
  it('Card renders its three deliberate variants, and none by default', () => {
    const { container: plain } = render(<Card>x</Card>);
    expect(plain.querySelector('.sv-card')?.className.trim()).toBe('sv-card');
    for (const variant of ['ledger', 'object', 'plate'] as const) {
      const { container } = render(<Card variant={variant}>x</Card>);
      expect(container.querySelector(`.sv-card--${variant}`)).not.toBeNull();
      cleanup();
    }
  });

  it('ledger has no background and hairline rules; plate is sunken and borderless', () => {
    const source = app();
    expect(source).toMatch(/\.sv-card--ledger\s*{[^}]*background:\s*transparent/);
    expect(source).toMatch(/\.sv-card--plate\s*{[^}]*background:\s*var\(--surface-sunken\)/);
    // Object cards respond to hover by border, never by lift or shadow.
    expect(source).toMatch(/\.sv-card--object:hover\s*{\s*border-color/);
    expect(source).not.toMatch(/\.sv-card--object:hover\s*{[^}]*(transform|box-shadow)/);
  });

  it('surfaces compose with headers without special casing', () => {
    render(
      <Card variant="ledger">
        <CardHeader title="Unit register" />
        <CardBody>rows</CardBody>
      </Card>,
    );
    expect(screen.getByText('Unit register')).toBeDefined();
  });
});

/* ================================================================== *
 * 4 · Buttons — the full state matrix
 * ================================================================== */

describe('button states', () => {
  it('loading keeps the label, adds a spinner, announces busy, and cannot be pressed', () => {
    render(<Button loading>Save booking</Button>);
    const button = screen.getByRole('button', { name: 'Save booking' });
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.querySelector('.sv-btn__spinner')).not.toBeNull();
    expect(button.querySelector('.sv-btn__spinner')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('a resting button carries none of the loading state', () => {
    render(<Button>Save booking</Button>);
    const button = screen.getByRole('button', { name: 'Save booking' });
    expect(button.getAttribute('aria-busy')).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.querySelector('.sv-btn__spinner')).toBeNull();
  });

  it('pressed, verified and failed states are styled without any press animation', () => {
    const source = app();
    expect(source).toMatch(/\.sv-btn:active:not\(:disabled\)/);
    expect(source).toMatch(/\.sv-btn\[data-phase='verified'\]/);
    expect(source).toMatch(/\.sv-btn\[data-phase='failed'\]/);
    // No transform on press — §10: "active translates 0".
    expect(source).not.toMatch(/\.sv-btn[^{]*:active[^{]*{[^}]*transform/);
  });

  it('the spinner is the one permitted functional loop, and it holds under reduced motion', () => {
    const source = app();
    expect(source).toMatch(/\.sv-btn__spinner\s*{[^}]*animation:\s*sv-spin[^}]*infinite/);
    expect(source).toMatch(/prefers-reduced-motion[^{]*{[^]*\.sv-btn__spinner\s*{[^}]*animation:\s*none/);
  });
});

/* ================================================================== *
 * 5 · Loading, skeletons and motion discipline
 * ================================================================== */

describe('motion discipline', () => {
  it('the skeleton shimmer is finite — nothing decorative is perpetual', () => {
    expect(app()).toMatch(/animation:\s*sv-shimmer\s+1\.6s\s+5\s*;/);
    expect(app()).not.toMatch(/sv-shimmer[^;}]*infinite/);
  });

  it('reduced motion zeroes every motion token, including the role aliases', () => {
    const t = tokens();
    expect(t).toMatch(/prefers-reduced-motion[^}]*--motion-fast:\s*0ms/);
    // Aliases point at the zeroed tokens, so they cannot drift.
    expect(t).toContain('--m-fast: var(--motion-fast)');
    expect(t).toContain('--m-cinematic: var(--motion-cinematic)');
  });

  it('reduced motion makes chart draw-in static, not absent', () => {
    const m = motion();
    expect(m).toMatch(/\.m-chart-line\s*{[^}]*stroke-dasharray/);
    expect(m).toMatch(/prefers-reduced-motion[^]*\.m-chart-line\s*{[^}]*stroke-dashoffset:\s*0/);
    expect(m).toMatch(/prefers-reduced-motion[^]*\.m-chart-bar\s*{[^}]*transform:\s*none/);
  });

  it('the phone bottom-sheet uses the same motion system as the side drawer', () => {
    expect(motion()).toContain('@keyframes m-sheet');
    expect(app()).toMatch(/max-width:\s*640px[^]*\.sv-drawer\.m-drawer-enter\s*{\s*animation-name:\s*m-sheet/);
  });
});

/* ================================================================== *
 * 6 · Focus — visible on whatever it sits on
 * ================================================================== */

describe('focus visibility', () => {
  it('the ring is a token, and olive surfaces switch to the inverse ring', () => {
    expect(tokens()).toContain('--focus-ring: var(--brand-green)');
    expect(tokens()).toContain('--focus-ring-inverse: var(--brand-gold-light)');
    const source = app();
    expect(source).toMatch(/:focus-visible\s*{\s*outline:\s*2px solid var\(--focus-ring\)/);
    // The rail is LIGHT since M-UI-2, so the olive ring is correct there; the surfaces
    // that stayed olive (skip link, primary buttons) take the gold-light inverse ring.
    expect(source).toMatch(/\.sv-skip-link:focus-visible[^{]*{\s*outline-color:\s*var\(--focus-ring-inverse\)/);
    expect(source).not.toMatch(/\.sv-sidebar :focus-visible/);
    expect(source).toMatch(/\.sv-sidebar\s*{[^}]*background:\s*var\(--surface-sunken\)/);
  });
});

/* ================================================================== *
 * 7 · Layout primitives — rhythm by declared gap
 * ================================================================== */

describe('composition primitives', () => {
  it('Stack, Cluster and Grid declare their gap as a spacing token', () => {
    const { container } = render(
      <Stack gap={5}>
        <Cluster gap={2}><Tag>2 BHK</Tag></Cluster>
        <Grid min="12rem"><span>a</span><span>b</span></Grid>
      </Stack>,
    );
    const stack = container.querySelector('.sv-stack') as HTMLElement;
    const cluster = container.querySelector('.sv-cluster') as HTMLElement;
    const grid = container.querySelector('.sv-grid') as HTMLElement;
    expect(stack.style.getPropertyValue('--stack-gap')).toBe('var(--s-5)');
    expect(cluster.style.getPropertyValue('--cluster-gap')).toBe('var(--s-2)');
    expect(grid.style.getPropertyValue('--grid-min')).toBe('12rem');
  });

  it('the spacing and radius role tokens exist', () => {
    const source = tokens();
    for (const token of ['--s-1:', '--s-5:', '--s-10:', '--r-1:', '--r-2:', '--r-pill:']) {
      expect(source, token).toContain(token);
    }
  });
});

/* ================================================================== *
 * 8 · Tags and chips
 * ================================================================== */

describe('tags and chips', () => {
  it('Tag is neutral metadata — it accepts no tone at all', () => {
    render(<Tag>Airbnb</Tag>);
    const tag = screen.getByText('Airbnb');
    expect(tag.className).toBe('sv-badge');
  });

  it('Chip is a real button and speaks aria-pressed when toggled', () => {
    render(<Chip pressed>February</Chip>);
    const chip = screen.getByRole('button', { name: 'February' });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    cleanup();
    render(<Chip>Ask about occupancy</Chip>);
    expect(screen.getByRole('button', { name: 'Ask about occupancy' }).getAttribute('aria-pressed')).toBeNull();
  });

  it('chips reach 44px on coarse pointers', () => {
    expect(app()).toMatch(/pointer:\s*coarse[^}]*{\s*\.sv-chip\s*{\s*min-height:\s*44px/);
  });
});

/* ================================================================== *
 * 9 · Table foundation
 * ================================================================== */

interface Row { id: string; name: string; nights: number }
const ROWS: Row[] = [
  { id: 'BK-1', name: 'Priya M.', nights: 3 },
  { id: 'BK-2', name: 'Arun K.', nights: 2 },
];
const COLUMNS: Column<Row>[] = [
  { key: 'id', header: 'Booking', render: (r) => r.id },
  { key: 'name', header: 'Guest', render: (r) => r.name },
  { key: 'nights', header: 'Nights', numeric: true, render: (r) => r.nights },
];

describe('table foundation', () => {
  it('every cell carries its column label, so the stacked phone layout can name it', () => {
    const { container } = render(
      <DataTable columns={COLUMNS} rows={ROWS} caption="Bookings" getRowKey={(r) => r.id} />,
    );
    const cells = [...container.querySelectorAll('tbody td')];
    expect(cells.length).toBe(6);
    expect(cells[0]?.getAttribute('data-label')).toBe('Booking');
    expect(cells[2]?.getAttribute('data-label')).toBe('Nights');
  });

  it('density, stacking and the sticky first column are explicit opt-in modes', () => {
    const { container } = render(
      <DataTable
        columns={COLUMNS} rows={ROWS} caption="Bookings" getRowKey={(r) => r.id}
        density="compact" mobile="stack" stickyFirstColumn
      />,
    );
    const table = container.querySelector('table')!;
    expect(table.className).toContain('sv-table--compact');
    expect(table.className).toContain('sv-table--stack');
    expect(table.className).toContain('sv-table--sticky-first');
  });

  it('an unadorned table gets none of the modes — no screen changes until it chooses', () => {
    const { container } = render(
      <DataTable columns={COLUMNS} rows={ROWS} caption="Bookings" getRowKey={(r) => r.id} />,
    );
    expect(container.querySelector('table')!.className.trim()).toBe('sv-table');
  });

  it('statement emphasis renders as row classes, never inline styles', () => {
    const { container } = render(
      <DataTable
        columns={COLUMNS} rows={ROWS} caption="P&L" getRowKey={(r) => r.id}
        getRowEmphasis={(r) => (r.id === 'BK-2' ? 'total' : undefined)}
      />,
    );
    expect(container.querySelector('tr.sv-table__row--total')).not.toBeNull();
    expect(container.querySelector('tbody [style]')).toBeNull();
    /*
     * The rules that carry the arithmetic exist: ink rule above subtotals, double above
     * totals — and they reach the row HEADER as well as the value cells. A statement row
     * names itself with `<th scope="row">`, so a rule matching only `td` left the label out
     * of the emphasis it was applying. Both selectors are asserted, so dropping either one
     * fails here rather than in somebody's eyes.
     */
    for (const cell of ['td', 'th']) {
      expect(app(), `subtotal ${cell}`)
        .toMatch(new RegExp(`sv-table__row--subtotal ${cell}[^{]*\\{[^}]*border-top:\\s*1px solid`));
      expect(app(), `total ${cell}`)
        .toMatch(new RegExp(`sv-table__row--total ${cell}[^{]*\\{[^}]*3px double`));
    }
  });

  it('the stacked layout keeps labels and drops the universal nowrap', () => {
    const source = app();
    expect(source).toMatch(/\.sv-table--stack td::before\s*{[^}]*content:\s*attr\(data-label\)/);
    expect(source).toMatch(/\.sv-table--stack td\s*{[^}]*white-space:\s*normal/);
  });

  it('the scroll container and hidden caption survive every mode', () => {
    render(
      <DataTable columns={COLUMNS} rows={ROWS} caption="Bookings" getRowKey={(r) => r.id} mobile="stack" />,
    );
    expect(screen.getByRole('region', { name: 'Bookings' })).toBeDefined();
    expect(document.querySelector('caption.sv-visually-hidden')?.textContent).toBe('Bookings');
  });
});

/* ================================================================== *
 * 10 · Chart foundation
 * ================================================================== */

const POINTS = [
  { label: 'Apr', value: 100000 }, { label: 'May', value: 140000 },
  { label: 'Jun', value: 120000 }, { label: 'Jul', value: 180000 },
];

describe('chart foundation', () => {
  it('renders without a layout engine — the measured width falls back, never crashes', () => {
    const { container } = render(<RevenueTrendChart points={POINTS} title="Revenue trend" />);
    expect(container.querySelector('svg')?.getAttribute('viewBox')).toMatch(/^0 0 \d+ \d+$/);
  });

  it('re-measures on window resize — the second channel when observer delivery is throttled', async () => {
    const original = Element.prototype.getBoundingClientRect;
    let currentWidth = 320;
    Element.prototype.getBoundingClientRect = function () {
      const rect = original.call(this);
      return { ...rect, width: currentWidth, toJSON: () => ({}) } as DOMRect;
    };
    try {
      const { container } = render(<RevenueTrendChart points={POINTS} title="Revenue trend" />);
      const viewBox = () => container.querySelector('svg')?.getAttribute('viewBox');

      /*
       * WAIT FOR THE OUTCOME, not for a fixed tick.
       *
       * Both assertions used to follow a single `setTimeout(…, 0)`, which assumes React
       * finishes measuring and re-rendering within one macrotask. It usually does — and under
       * a loaded machine running the whole suite it sometimes does not, so this test failed
       * intermittently on a chart that was working perfectly. A poll asserts the same
       * property without depending on how busy the box is.
       */
      await waitFor(() => expect(viewBox()).toBe('0 0 320 260'));

      currentWidth = 640;
      window.dispatchEvent(new Event('resize'));
      await waitFor(() => expect(viewBox()).toBe('0 0 640 260'));
    } finally {
      Element.prototype.getBoundingClientRect = original;
    }
  });

  it('keeps the accessible pairing: role, label, and the hidden data table', () => {
    render(<OccupancyTrendChart points={POINTS.map((p) => ({ ...p, value: 0.7 }))} title="Occupancy trend" />);
    expect(screen.getByRole('img', { name: /Occupancy trend/ })).toBeDefined();
    const table = document.querySelector('table.sv-visually-hidden');
    expect(table?.querySelector('caption')?.textContent).toBe('Occupancy trend');
  });

  it('points are keyboard-reachable: focus mirrors hover', () => {
    const { container } = render(<RevenueTrendChart points={POINTS} title="Revenue trend" />);
    const focusable = [...container.querySelectorAll('[tabindex="0"]')];
    expect(focusable.length).toBe(POINTS.length);
    expect(focusable[0]?.getAttribute('aria-label')).toContain('Apr');
  });

  it('draw-in rides the motion system, so reduced motion kills it with everything else', () => {
    const { container } = render(<RevenueTrendChart points={POINTS} title="Revenue trend" />);
    expect(container.querySelector('path.m-chart-line')).not.toBeNull();
  });

  it('no chart source hardcodes a series hex — colours are the chart tokens', () => {
    const source = codeOnly(read('components/charts/Charts.tsx'));
    expect(source).not.toMatch(/#[0-9A-Fa-f]{6}/);
    expect(source).toContain('var(--chart-1)');
  });
});

/* ================================================================== *
 * 11 · Vocabulary — shared components never speak machinery
 * ================================================================== */

describe('vocabulary', () => {
  it('the shared page error no longer prints raw Error.message', () => {
    const source = read('lib/shared/page-helpers.tsx');
    expect(codeOnly(source)).not.toMatch(/error\.message/);
    expect(source).toContain("We couldn't load this screen's data.");
  });

  it('the environment label carries no "(fixtures)" suffix anywhere', () => {
    expect(codeOnly(read('lib/server/environment/config.ts'))).not.toContain('(fixtures)');
    expect(codeOnly(read('lib/shared/environment.ts'))).not.toContain('(fixtures)');
  });

  it('and no test gate is still waiting for that deleted suffix', () => {
    /*
     * The other half of the rule above. The real-demo suite used to decide whether the
     * LIVE demo workbook was present by looking for "(fixtures)" in the sign-in page —
     * so deleting the suffix silently opened the gate, and nineteen tests spent several
     * milestones passing against fixtures while claiming to prove the live workbook.
     * A string that the product is forbidden to emit cannot be something a gate waits for.
     */
    expect(codeOnly(read('e2e/real-demo.spec.ts'))).not.toContain('(fixtures)');
  });

  it('no roadmap badge survives in a screen a client sees', () => {
    expect(read('app/admin/investors/reports/page.tsx')).not.toContain('Phase 7</Badge>');
  });

  it('the layout ladder is tokenised: content max and z-index rungs', () => {
    expect(tokens()).toContain('--content-max: 1360px');
    for (const rung of ['--z-topbar', '--z-scrim', '--z-nav', '--z-overlay', '--z-toast', '--z-skip']) {
      expect(tokens(), rung).toContain(`${rung}:`);
    }
    // app.css consumes the ladder rather than numbering layers ad hoc.
    expect(app()).toContain('z-index: var(--z-overlay)');
    expect(app()).toContain('z-index: var(--z-toast)');
  });
});
