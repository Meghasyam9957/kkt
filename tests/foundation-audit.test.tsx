/**
 * FOUNDATION AUDIT FIXES.
 *
 * Every assertion here corresponds to a gap that was VERIFIED present in the shipped
 * Verandah Ledger foundation by an adversarial review run after M-UI-1 landed — a focus
 * ring nobody could see in dark theme, a mobile drawer a touch user could not close, an
 * off-screen rail that still held the keyboard, a dashboard that printed connector
 * strings at people, and a set of type-role tokens the components never actually used.
 *
 * The fixes are cheap. The tests are the part that stops them coming back.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import fs from 'node:fs';
import path from 'node:path';

import { OccupancyTrendChart } from '@/components/charts/Charts';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const app = () => read('styles/app.css');
const tokens = () => read('styles/tokens.css');
const codeOnly = (s: string) =>
  s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const POINTS = [
  { label: 'Apr', value: 0.7 }, { label: 'May', value: 0.8 },
  { label: 'Jun', value: 0.6 }, { label: 'Jul', value: 0.9 },
];

beforeEach(() => cleanup());

/* ================================================================== *
 * Accessibility
 * ================================================================== */

describe('audit fix · focus is visible on every surface and theme', () => {
  it('the ring follows the theme — olive on light, retuned ink on dark', () => {
    const source = tokens();
    expect(source).toContain('--focus-ring: var(--brand-green)');
    // Olive is 2.5:1 on the dark page. Both dark selectors must retune it.
    expect((source.match(/--focus-ring: #A8BC72/g) ?? []).length).toBe(2);
  });

  it('the inverse ring is drawn INSIDE the olive fill, not on the cream page', () => {
    // A positive offset put gold-light (1.6:1 on cream) outside the button entirely.
    expect(app()).toMatch(
      /\.sv-skip-link:focus-visible,\s*\.sv-btn--primary:focus-visible\s*\{[^}]*outline-offset:\s*-3px/);
  });
});

describe('audit fix · the hidden rail releases the keyboard', () => {
  it('the closed rail leaves the tab order below the desktop rung', () => {
    const source = app();
    // `transform` alone hides it visually while leaving ~29 links focusable.
    expect(source).toMatch(/\.sv-sidebar\s*\{[^}]*visibility:\s*hidden/);
    expect(source).toMatch(/\.sv-sidebar--open\s*\{[^}]*visibility:\s*visible/);
  });
});

describe('audit fix · the drawer can always be dismissed', () => {
  it('useInertOutside accepts exemptions and honours a data attribute', () => {
    const source = read('components/ui/focus.ts');
    expect(source).toContain('exempt');
    expect(source).toContain('data-inert-exempt');
    expect(source).toContain('spared.has(el)');
  });

  it('the shell exempts the scrim, so a tap on it still closes the drawer', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(shell).toContain('useInertOutside(sidebarRef, mobileOpen, [scrimRef])');
    expect(shell).toContain('ref={scrimRef}');
  });

  it('the drawer also carries its own close control inside the trapped subtree', () => {
    const shell = read('components/shell/AppShell.tsx');
    expect(shell).toContain('sv-sidebar__close');
    expect(shell).toContain('Close menu');
  });

  it('every icon-only control meets the 44px floor on coarse pointers', () => {
    const coarse = (app().match(/@media \(pointer: coarse\)[\s\S]*?\n\}/g) ?? []).join('\n');
    for (const control of [
      '.sv-topbar__menu', '.sv-topbar__icon', '.sv-overlay__close',
      '.sv-toast__dismiss', '.sv-filter__reset',
    ]) {
      expect(coarse, control).toContain(control);
    }
  });
});

/* ================================================================== *
 * Vocabulary and hierarchy
 * ================================================================== */

describe('audit fix · no screen prints machinery at a person', () => {
  it('no user-facing read path interpolates a raw Error.message', () => {
    for (const file of ['app/admin/dashboard/page.tsx', 'lib/shared/page-helpers.tsx']) {
      const source = codeOnly(read(file));
      expect(source, file).not.toMatch(/error\.message/);
    }
    // …and the diagnostic still reaches the operator's log.
    expect(read('app/admin/dashboard/page.tsx')).toContain('console.error');
  });
});

describe('audit fix · the type roles are real', () => {
  it('every declared role token is actually consumed', () => {
    const source = app();
    // tokens.css promises "components use ROLES, not raw sizes"; six were dead.
    for (const role of ['--t-h1', '--t-h2', '--t-kpi', '--t-small', '--t-num-secondary', '--t-body']) {
      expect(source, `${role} is declared but never used`).toContain(`var(${role})`);
    }
  });

  it('serif is never set below the 18px floor', () => {
    const SIZES: Record<string, number> = {
      '--t-hero': 2.25, '--t-h1': 1.875, '--t-h2': 1.25, '--t-kpi': 1.75,
      '--t-num-secondary': 1.125, '--t-body': 0.9375, '--t-small': 0.8125,
    };
    for (const block of codeOnly(app()).split('}')) {
      if (!block.includes('var(--font-display)')) continue;
      const size = block.match(/font-size:\s*([^;]+)/)?.[1]?.trim();
      if (!size) continue;
      const token = size.match(/var\((--t-[a-z-]+)\)/)?.[1];
      const clamped = size.match(/clamp\(\s*(\d*\.?\d+)rem/)?.[1];
      const plain = size.match(/^(\d*\.?\d+)rem/)?.[1];
      const effective = clamped ? Number(clamped)
        : token ? SIZES[token]
        : plain ? Number(plain) : NaN;
      if (!Number.isFinite(effective)) continue;
      expect(effective, `serif at ${size} — ${block.slice(0, 70).trim()}`).toBeGreaterThanOrEqual(1.125);
    }
  });

  it('a primary KPI figure never renders smaller than a secondary one', () => {
    // The old 1.0625rem floor put PRIMARY (17px) under SECONDARY (18px) below ~1036px.
    const floor = app().match(/\.sv-kpi-row \.sv-kpi__value\s*\{[^}]*clamp\(\s*([\d.]+)rem/)?.[1];
    expect(Number(floor)).toBeGreaterThanOrEqual(1.125);
  });
});

describe('audit fix · the semantic vocabulary is complete', () => {
  it('NEUTRAL is a real tone with its own pair, in both themes', () => {
    const source = app();
    expect(source).toContain('.sv-pill--neutral');
    expect(source).toContain('.sv-badge--neutral');
    expect(source).toContain('.sv-badge--info');
    // It was the one semantic pair the dark theme never redefined.
    expect((tokens().match(/--neutral-fg: #A5A493/g) ?? []).length).toBe(2);
  });

  it('no status colour is paired with a hardcoded hex', () => {
    // #fff on --bad-fg fell to ~2.1:1 once dark theme lightened that token.
    expect(app()).not.toMatch(/color:\s*#fff\b/);
    expect(app()).toMatch(/\.sv-topbar__count\s*\{[^}]*color:\s*var\(--surface-page\)/);
  });

  it('statement rules use the retuned brand ink so they survive dark theme', () => {
    const source = app();
    // `[^{]*` rather than `\s*`: the rule now carries a selector LIST (td and th), because a
    // statement row labels itself with a row header. The ink it uses is what matters here.
    expect(source).toMatch(/row--subtotal td[^{]*\{[^}]*var\(--text-brand\)/);
    expect(source).toMatch(/row--total td[^{]*\{[^}]*var\(--text-brand\)/);
  });

  it('a verified write reads as success, not as disabled', () => {
    expect(app()).toMatch(/\.sv-btn:disabled:not\(\[data-phase='verified'\]\)/);
  });
});

/* ================================================================== *
 * Responsive
 * ================================================================== */

describe('audit fix · responsive', () => {
  it('the content column is centred, so wide screens do not strand it left', () => {
    expect(app()).toMatch(/\.sv-content\s*\{[^}]*margin-inline:\s*auto/);
  });

  it('auto-fit grids cannot exceed a narrow column', () => {
    const source = app();
    // .sv-split's 22rem minimum overflowed a 343px column at 375px (Today's board).
    expect(source).toMatch(/\.sv-split\s*\{[^}]*minmax\(min\(22rem,\s*100%\)/);
    // The shared primitive already carried the guard; both must keep it.
    expect(source).toMatch(/\.sv-grid\s*\{[^}]*minmax\(min\(var\(--grid-min[^)]*\),\s*100%\)/);
  });
});

/* ================================================================== *
 * Charts
 * ================================================================== */

describe('audit fix · charts reach every input', () => {
  it('hit areas span the category pitch and accept pointer, mouse and keyboard', () => {
    const source = read('components/charts/Charts.tsx');
    expect(source).toContain('function HitArea');
    // Painted bars are ~6px wide on a phone; the target is the whole column.
    expect(source).toContain('onPointerDown');
    expect(source).toMatch(/width=\{pitch\}|width=\{groupW\}/);
  });

  it('every SVG chart renders a live readout outside the img subtree', () => {
    // role="img" prunes descendants, so a focused bar announces nothing by itself.
    const source = read('components/charts/Charts.tsx');
    expect(source).toContain('function ChartReadout');
    expect(source).toContain('aria-live="polite"');
    expect((source.match(/<ChartReadout/g) ?? []).length).toBe(3);
  });

  it('the readout speaks the point the keyboard reaches', () => {
    const { container } = render(<OccupancyTrendChart points={POINTS} title="Occupancy trend" />);
    const live = container.querySelector('[aria-live="polite"]')!;
    expect(live.textContent).toBe('');
    fireEvent.focus(container.querySelectorAll('[tabindex="0"]')[0]!);
    expect(live.textContent).toContain('Apr');
  });

  it('a tap activates the same readout — not just a mouse', () => {
    const { container } = render(<OccupancyTrendChart points={POINTS} title="Occupancy trend" />);
    const live = container.querySelector('[aria-live="polite"]')!;
    fireEvent.pointerDown(container.querySelectorAll('[tabindex="0"]')[1]!);
    expect(live.textContent).toContain('May');
  });

  it('legend swatches carry the same treatment as the marks they label', () => {
    const source = read('components/charts/Charts.tsx');
    expect(source).toContain('opacity?: number');

    /*
     * Asserted as a RELATIONSHIP, not as a literal. This used to pin the value to
     * `opacity: 0.28`, which meant the guard failed the moment that opacity was corrected —
     * and 0.28 was wrong: the revenue band came out around 1.5:1 on white, below the 3:1
     * that makes a graphical object perceivable at all.
     *
     * What the test is actually for is that the swatch and the mark carry the SAME
     * treatment, so a solid swatch never stands beside a translucent band. Reading both
     * numbers and comparing them says that, and keeps saying it whatever the value becomes.
     */
    const legend = source.match(/label: 'Net revenue'[^}]*opacity:\s*([\d.]+)/);
    const css = read('styles/app.css')
      .match(/\.sv-bar-row__bar--revenue\s*\{[^}]*opacity:\s*([\d.]+)/);
    expect(legend, 'the revenue legend entry declares an opacity').not.toBeNull();
    expect(css, 'the revenue bar declares an opacity').not.toBeNull();
    expect(Number(legend![1]), 'legend swatch matches the mark it labels')
      .toBeCloseTo(Number(css![1]), 5);
    // …and the mark is perceivable: below ~0.4 the band is under 3:1 on a white card.
    expect(Number(css![1])).toBeGreaterThanOrEqual(0.4);
  });
});
