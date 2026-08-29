/**
 * SHELL, NAVIGATION & ROLE-AWARE ENTRY (M-UI-2).
 *
 * The menu is presentation, but a dishonest menu still misleads: aliased labels lighting
 * up together, links to screens that do not exist, a booking concept with two names, and
 * two roles whose front door was an access-denied screen. These tests keep the repaired
 * IA honest the same way the RBAC suite keeps the grants honest.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import fs from 'node:fs';
import path from 'node:path';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { PathnameContext } from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { NAVIGATION, visibleNavigation, breadcrumbFor } from '@/lib/shared/navigation';
import {
  ROLES, capabilitiesFor, FINANCIAL_CAPABILITIES, type Capability, type Role,
} from '@/lib/shared/roles';
import { propertyOptionLabel } from '@/lib/shared/format';
import { NAV_ICONS } from '@/components/ui/icons';
import { AppShell } from '@/components/shell/AppShell';
import { ENVIRONMENT_DESCRIPTORS, type PublicEnvironmentInfo } from '@/lib/shared/environment';
import type { DataMeta } from '@/lib/data/providers/types';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const allItems = NAVIGATION.flatMap((s) => s.items);
const forRole = (role: Role) => {
  const granted = new Set<Capability>(capabilitiesFor(role));
  return visibleNavigation((c) => granted.has(c), { demoControls: true });
};

beforeEach(() => cleanup());

/* ================================================================== *
 * 1 · The menu tells the truth
 * ================================================================== */

describe('navigation honesty', () => {
  it('no two items share an href — the alias defect cannot return', () => {
    const hrefs = allItems.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });

  it('every navigation href is a real page', () => {
    for (const item of allItems) {
      const file = path.join(ROOT, 'app', ...item.href.split('/').filter(Boolean), 'page.tsx');
      expect(fs.existsSync(file), `${item.label} → ${item.href}`).toBe(true);
    }
  });

  it('every breadcrumb segment a nav href produces is itself a real destination', () => {
    // The Finance crumb used to 404; now every intermediate the trail links must exist.
    for (const item of allItems) {
      for (const crumb of breadcrumbFor(item.href)) {
        const file = path.join(ROOT, 'app', ...crumb.href.split('/').filter(Boolean), 'page.tsx');
        expect(fs.existsSync(file), `${item.href} breadcrumbs via ${crumb.href}`).toBe(true);
      }
    }
  });

  it('Compliance and Audit are not links while their screens do not exist', () => {
    const labels = allItems.map((i) => i.label);
    expect(labels).not.toContain('Compliance');
    expect(labels).not.toContain('Audit');
    expect(labels.filter((l) => l === 'Settings')).toHaveLength(1);
  });

  it('every navigation label has a drawn icon', () => {
    for (const item of allItems) {
      expect(NAV_ICONS[item.label], `${item.label} has no icon`).toBeDefined();
    }
  });
});

/* ================================================================== *
 * 2 · One booking concept
 * ================================================================== */

describe('canonical bookings', () => {
  it('"Bookings" is the one working booking screen, under Operations', () => {
    const bookings = allItems.filter((i) => i.label === 'Bookings');
    expect(bookings).toHaveLength(1);
    expect(bookings[0]!.href).toBe('/admin/operations/reservations');
  });

  it('the financial view of bookings is a ledger entry gated by a financial capability', () => {
    const ledger = allItems.find((i) => i.href === '/admin/reservations');
    expect(ledger?.label).toBe('Booking Ledger');
    expect(FINANCIAL_CAPABILITIES).toContain(ledger!.capability);
  });

  it('no item is labelled "Reservations" any more', () => {
    expect(allItems.map((i) => i.label)).not.toContain('Reservations');
  });

  it('operations sees Bookings and never the ledger', () => {
    const labels = forRole('OPERATIONS').flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toContain('Bookings');
    expect(labels).not.toContain('Booking Ledger');
  });
});

/* ================================================================== *
 * 3 · Role menus
 * ================================================================== */

describe('role menus', () => {
  it('operations: operational screens only, nothing financial, no settings', () => {
    const labels = forRole('OPERATIONS').flatMap((s) => s.items.map((i) => i.label));
    for (const expected of ['Today', 'Bookings', 'Check-ins', 'Check-outs', 'Housekeeping', 'Maintenance', 'Inventory', 'Guest Requests', 'Properties']) {
      expect(labels, expected).toContain(expected);
    }
    for (const hidden of ['Dashboard', 'Revenue', 'Booking Ledger', 'Expenses', 'CAPEX', 'Cash Flow', 'P&L', 'Investors', 'Distributions', 'Reports', 'Performance', 'Forecast', 'Settings', 'Srivillu Copilot']) {
      expect(labels, hidden).not.toContain(hidden);
    }
  });

  it('admin: management set incl. the ledger and exactly one Settings', () => {
    const labels = forRole('ADMIN').flatMap((s) => s.items.map((i) => i.label));
    for (const expected of ['Dashboard', 'Booking Ledger', 'P&L', 'Investors', 'Settings', 'Srivillu Copilot']) {
      expect(labels, expected).toContain(expected);
    }
    expect(labels.filter((l) => l === 'Settings')).toHaveLength(1);
  });

  it('investor: exactly their portfolio, nothing else', () => {
    const labels = forRole('INVESTOR').flatMap((s) => s.items.map((i) => i.label));
    expect(labels).toEqual(['Portfolio']);
  });
});

/* ================================================================== *
 * 4 · Role-aware entry
 * ================================================================== */

describe('front door', () => {
  it('/ hands off to /admin, where the server resolves the role', () => {
    const source = read('app/page.tsx');
    expect(source).toContain("redirect('/admin')");
    expect(source).not.toContain("redirect('/admin/dashboard')");
  });

  it('/admin routes each role to a home it can open', () => {
    const source = read('app/admin/page.tsx');
    expect(source).toContain("redirect('/admin/portfolio')");
    expect(source).toContain("redirect('/admin/operations/today')");
    expect(source).toContain("redirect('/admin/dashboard')");
    expect(source).toContain("redirect('/signin')");
  });

  it('/admin/finance is a real destination, landing on Revenue', () => {
    expect(read('app/admin/finance/page.tsx')).toContain("redirect('/admin/finance/revenue')");
  });
});

/* ================================================================== *
 * 5 · The rendered shells
 * ================================================================== */

const inertRouter = {
  push: () => {}, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: () => {},
} as unknown as AppRouterInstance;

const DEMO_ENVIRONMENT: PublicEnvironmentInfo = {
  ...ENVIRONMENT_DESCRIPTORS.demo,
  dataSourceLabel: 'Demo Workbook',
  fixtures: true,
};

const META: DataMeta = {
  source: 'FIXTURE', asOf: new Date().toISOString(), period: '2027-01',
  freshness: 'GOOD', demo: true,
};

function renderShell(ui: React.ReactElement, pathname = '/admin/dashboard') {
  return render(
    <AppRouterContext.Provider value={inertRouter}>
      <PathnameContext.Provider value={pathname}>{ui}</PathnameContext.Provider>
    </AppRouterContext.Provider>,
  );
}

describe('rendered shells', () => {
  it('the admin shell renders the rail with exactly one active item', () => {
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Demo Administrator', email: 'admin@srivillu.test', role: 'ADMIN' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={3}
      ><p>content</p></AppShell>,
      '/admin/dashboard',
    );
    expect(container.querySelector('.sv-sidebar')).not.toBeNull();
    const active = container.querySelectorAll('.sv-nav__link--active');
    expect(active).toHaveLength(1);
    expect(active[0]?.textContent).toContain('Dashboard');
    // The bell carries the count the layout computed from the operations board.
    expect(screen.getByLabelText(/3 items need attention/)).toBeDefined();
  });

  it('a zero alert count renders the bell without a badge', () => {
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Demo Administrator', email: 'admin@srivillu.test', role: 'ADMIN' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={0}
      ><p>content</p></AppShell>,
    );
    expect(screen.getByLabelText(/Nothing needs attention/)).toBeDefined();
    expect(container.querySelector('.sv-topbar__count')).toBeNull();
  });

  it('the investor shell has no rail, no breadcrumb, no bell — and says whose it is', () => {
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Anand Rao', email: 'a@srivillu.test', role: 'INVESTOR' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={0}
      ><p>portfolio</p></AppShell>,
      '/admin/portfolio',
    );
    expect(container.querySelector('.sv-sidebar')).toBeNull();
    expect(container.querySelector('.sv-breadcrumb')).toBeNull();
    expect(container.querySelector('.sv-topbar__icon')).toBeNull();
    expect(container.querySelector('.sv-invmast')).not.toBeNull();
    expect(screen.getByText('Investor')).toBeDefined();
    expect(screen.getByText('Anand Rao')).toBeDefined();
    // The skip link and main landmark survive the variant.
    expect(container.querySelector('a.sv-skip-link')).not.toBeNull();
    expect(container.querySelector('main#main')).not.toBeNull();
  });

  it('the operations shell menu carries no financial vocabulary at all', () => {
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Demo Operations Manager', email: 'ops@srivillu.test', role: 'OPERATIONS' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={1}
      ><p>today</p></AppShell>,
      '/admin/operations/today',
    );
    const nav = container.querySelector('.sv-nav')!.textContent ?? '';
    expect(nav).not.toMatch(/Revenue|Expense|P&L|Investor|Ledger|Cash/i);
    expect(nav).toContain('Today');
    expect(nav).toContain('Bookings');
  });

  it('opening the mobile drawer leaves the scrim tappable, and inerts everything else', async () => {
    /*
     * The regression this pins: useInertOutside swept EVERY sibling of the rail, which
     * included the scrim — a control labelled "Close navigation" that swallowed every
     * tap. On a phone that left Escape as the only exit, and phones have no Escape.
     */
    const user = userEvent.setup();
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Demo Administrator', email: 'admin@srivillu.test', role: 'ADMIN' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={0}
      ><p>content</p></AppShell>,
    );
    await user.click(screen.getByRole('button', { name: 'Open navigation' }));

    const scrim = container.querySelector('.sv-scrim')!;
    expect(scrim, 'the scrim must exist while the drawer is open').not.toBeNull();
    expect(scrim.hasAttribute('inert'), 'the scrim must stay interactive').toBe(false);
    // …while the page behind genuinely is inert.
    expect(container.querySelector('.sv-main')?.hasAttribute('inert')).toBe(true);

    // And the drawer carries its own labelled exit inside the trapped subtree,
    // under a name distinct from the scrim's.
    const close = screen.getByRole('button', { name: 'Close menu' });
    expect(container.querySelector('.sv-sidebar')?.contains(close)).toBe(true);
    expect(screen.getAllByRole('button', { name: 'Close navigation' })).toHaveLength(1);
  });

  it('the rail collapse toggles, announces its state, and keeps tooltips', async () => {
    const user = userEvent.setup();
    const { container } = renderShell(
      <AppShell
        user={{ name: 'Demo Administrator', email: 'admin@srivillu.test', role: 'ADMIN' }}
        meta={META} environment={DEMO_ENVIRONMENT} alertCount={0}
      ><p>content</p></AppShell>,
    );
    const toggle = screen.getByRole('button', { name: 'Collapse the navigation rail' });
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    await user.click(toggle);
    expect(container.querySelector('.sv-shell--railmin')).not.toBeNull();
    const expand = screen.getByRole('button', { name: 'Expand the navigation rail' });
    expect(expand.getAttribute('aria-pressed')).toBe('true');
    // Icons-only mode names each destination for the pointer.
    const link = container.querySelector('.sv-nav__link');
    expect(link?.getAttribute('title')).toBeTruthy();
  });
});

/* ================================================================== *
 * 6 · Property identity
 * ================================================================== */

describe('property identity', () => {
  it('names lead and the ID identifies', () => {
    expect(propertyOptionLabel({ id: 'HYD-501', name: '5th Floor — 2 BHK' }))
      .toBe('5th Floor — 2 BHK · HYD-501');
  });

  it('a missing or degenerate name falls back to the ID — never to an invention', () => {
    expect(propertyOptionLabel({ id: 'HYD-501', name: '' })).toBe('HYD-501');
    expect(propertyOptionLabel({ id: 'HYD-501', name: '  ' })).toBe('HYD-501');
    expect(propertyOptionLabel({ id: 'HYD-501', name: 'HYD-501' })).toBe('HYD-501');
  });

  it('the filter bar renders options through the shared label', () => {
    const source = read('components/shell/FilterBar.tsx');
    expect(source).toContain('propertyOptionLabel(option)');
  });

  it('the directory is identity only — no financial field can ride along', () => {
    const source = read('lib/data/views/workbook-views.ts');
    expect(source).toContain('propertyDirectory()');
    expect(source).toContain('({ id: p.PropertyID, name: p.Unit })');
  });
});

/* ================================================================== *
 * 7 · Role menus never drift from the grants
 * ================================================================== */

describe('menu/grant coherence', () => {
  it('no role is offered a link its grants cannot open (nav-level mirror of page-access)', () => {
    for (const role of ROLES) {
      const granted = new Set<Capability>(capabilitiesFor(role));
      for (const item of forRole(role).flatMap((s) => s.items)) {
        expect(granted.has(item.capability), `${role} sees ${item.label}`).toBe(true);
      }
    }
  });
});
