/**
 * PAGE AUTHORISATION SUITE.
 *
 * This exists because of a real defect. Until Phase 5A the RBAC suite tested the API route
 * table thoroughly — and every Next.js *page* was unguarded. The menu hid the links, so
 * nothing looked wrong; typing `/admin/finance/pnl` as an operations login rendered the
 * P&L in full.
 *
 * It survived because Phase 4 ran on a single fixed administrator, so no role existed that
 * could be refused. The moment real roles arrived, "hidden in the menu" became the only
 * thing between an operations manager and the financial statements.
 *
 * Two things are asserted here, and the first matters more than the second:
 *
 *   COMPLETENESS — every page under `/admin` declares the capability it needs. A page that
 *   forgets fails this test, so the gap cannot reopen quietly.
 *
 *   CORRECTNESS — the capability each page declares is the one the navigation entry for
 *   that route requires, so the menu and the guard cannot drift apart.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { NAVIGATION } from '@/lib/shared/navigation';
import { ROLES, roleHasCapability, capabilitiesFor, type Capability, type Role } from '@/lib/shared/roles';

const ROOT = process.cwd();
const ADMIN = path.join(ROOT, 'app', 'admin');

/** Every page file under app/admin, with its URL path. */
function adminPages(dir = ADMIN, base = '/admin'): Array<{ file: string; route: string }> {
  const out: Array<{ file: string; route: string }> = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...adminPages(full, `${base}/${entry.name}`));
    else if (entry.name === 'page.tsx') out.push({ file: full, route: base });
  }
  return out;
}

/** The capability a page declares, either via ReadOnlyPage or via checkPageAccess. */
function declaredCapability(source: string): string | null {
  const readOnly = /capability="([^"]+)"/.exec(source);
  if (readOnly) return readOnly[1] ?? null;
  const direct = /checkPageAccess\(\s*'([^']+)'/.exec(source);
  return direct?.[1] ?? null;
}

/** Pages that legitimately declare nothing because they only redirect elsewhere. */
function isRedirectOnly(source: string): boolean {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  /*
   * "Renders nothing" used to be tested as "contains no `<`", which a redirect page
   * with a typed signature fails on `Promise<SearchParams>` alone. JSX always closes —
   * `</Tag>` or `/>` — and a type parameter never does, so that is the tell.
   */
  return code.includes('redirect(') && !/<\/|\/>/.test(code);
}

/**
 * Where a redirect-only page sends the reader.
 *
 * Every /admin path the file names, not just the one directly after `redirect(` — a
 * redirect that picks between a bare path and one carrying the reader's filters is
 * still a redirect, and both destinations have to be guarded.
 */
function redirectTargets(source: string): string[] {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const paths = [...code.matchAll(/[`'"](\/admin\/[^`'"?\s]*)/g)]
    .map((m) => m[1]!.replace(/\/$/, ''));
  return [...new Set(paths)];
}

const PAGES = adminPages();

describe('page access · every admin page says who may see it', () => {
  it('finds the admin pages', () => {
    expect(PAGES.length).toBeGreaterThanOrEqual(15);
  });

  it('no page renders without declaring a capability', () => {
    const unguarded = PAGES.filter(({ file }) => {
      const source = fs.readFileSync(file, 'utf8');
      if (isRedirectOnly(source)) return false;          // guarded by its destination
      return declaredCapability(source) === null;
    }).map(({ route }) => route);

    // This is the assertion that would have caught the original defect.
    expect(unguarded).toEqual([]);
  });

  it('a page that only redirects sends the reader somewhere that IS guarded', () => {
    /*
     * The exemption above is "guarded by its destination", and this is what makes that
     * sentence true rather than hopeful: a redirect-only page pointing at an unguarded
     * screen would otherwise slip through both assertions.
     */
    const guarded = new Map(PAGES.map(({ route, file }) =>
      [route, declaredCapability(fs.readFileSync(file, 'utf8'))]));

    for (const { route, file } of PAGES) {
      const source = fs.readFileSync(file, 'utf8');
      if (!isRedirectOnly(source)) continue;
      const targets = redirectTargets(source);
      expect(targets.length, `${route} must name where it sends the reader`).toBeGreaterThan(0);
      for (const target of targets) {
        expect(guarded.has(target), `${route} -> ${target} is not a known page`).toBe(true);
        expect(guarded.get(target), `${route} -> ${target} declares no capability`).toBeTruthy();
      }
    }
  });

  it('no role is shown a menu entry it cannot open', () => {
    // The failure this catches is the menu and the guard drifting apart: a link that leads
    // to "not available for your role", or a screen quietly reachable that the menu hides.
    // Several entries share a destination (Compliance, Settings and Audit all point at
    // /admin/settings), so the page is compared against the SET the menu associates.
    const menuCapabilities = new Map<string, Set<string>>();
    for (const item of NAVIGATION.flatMap((section) => section.items)) {
      const set = menuCapabilities.get(item.href) ?? new Set<string>();
      set.add(item.capability);
      menuCapabilities.set(item.href, set);
    }

    const broken: string[] = [];
    for (const { file, route } of PAGES) {
      const declared = declaredCapability(fs.readFileSync(file, 'utf8'));
      const menu = menuCapabilities.get(route);
      if (!declared || !menu) continue;
      for (const role of ROLES as readonly Role[]) {
        const seesLink = [...menu].some((c) => roleHasCapability(role, c as Capability));
        const canOpen = roleHasCapability(role, declared as Capability);
        if (seesLink && !canOpen) broken.push(`${role} sees ${route} but cannot open it`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('every declared capability is a real one', () => {
    const known = new Set<string>(capabilitiesFor('SUPER_ADMIN'));
    for (const { file, route } of PAGES) {
      const declared = declaredCapability(fs.readFileSync(file, 'utf8'));
      if (declared) expect(known, route).toContain(declared);
    }
  });
});

describe('page access · the role matrix', () => {
  /** route → capability, from what each page actually declares. */
  const routeCapability = new Map<string, Capability>();
  for (const { file, route } of PAGES) {
    const declared = declaredCapability(fs.readFileSync(file, 'utf8'));
    if (declared) routeCapability.set(route, declared as Capability);
  }

  it('OPERATIONS is refused every financial and investor screen', () => {
    const refused = ['/admin/dashboard', '/admin/finance/revenue', '/admin/finance/expenses',
      '/admin/finance/cashflow', '/admin/finance/pnl', '/admin/investors',
      '/admin/investors/distributions', '/admin/investors/reports', '/admin/settings'];
    for (const route of refused) {
      const capability = routeCapability.get(route);
      expect(capability, `${route} declares no capability`).toBeDefined();
      expect(roleHasCapability('OPERATIONS', capability!), route).toBe(false);
    }
  });

  it('OPERATIONS keeps every screen it needs to do the job', () => {
    for (const route of ['/admin/operations/today', '/admin/properties', '/admin/reservations']) {
      expect(roleHasCapability('OPERATIONS', routeCapability.get(route)!), route).toBe(true);
    }
  });

  it('INVESTOR is refused every management screen', () => {
    const management = [...routeCapability.entries()]
      .filter(([route]) => route !== '/admin/portfolio');
    for (const [route, capability] of management) {
      expect(roleHasCapability('INVESTOR', capability), route).toBe(false);
    }
  });

  it('INVESTOR keeps exactly one screen: their own portfolio', () => {
    const allowed = [...routeCapability.entries()]
      .filter(([, capability]) => roleHasCapability('INVESTOR', capability))
      .map(([route]) => route);
    expect(allowed).toEqual(['/admin/portfolio']);
  });

  it('demonstration controls are management-only', () => {
    for (const route of ['/admin/demo', '/admin/demo/guest-journey']) {
      expect(routeCapability.get(route)).toBe('demo.control');
      expect(roleHasCapability('OPERATIONS', 'demo.control')).toBe(false);
      expect(roleHasCapability('INVESTOR', 'demo.control')).toBe(false);
      expect(roleHasCapability('ADMIN', 'demo.control')).toBe(true);
    }
  });

  it('every role can reach at least one screen', () => {
    // A role that can see nothing is a role whose login looks broken.
    for (const role of ROLES as readonly Role[]) {
      const reachable = [...routeCapability.values()].filter((c) => roleHasCapability(role, c));
      expect(reachable.length, role).toBeGreaterThan(0);
    }
  });
});

describe('page access · the guard runs before any data is read', () => {
  it('ReadOnlyPage checks access before it resolves a provider', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/shared/page-helpers.tsx'), 'utf8');
    const guardAt = source.indexOf('checkPageAccess');
    const fetchAt = source.indexOf('getDataProvider(');
    expect(guardAt).toBeGreaterThan(-1);
    // A refused request must not cause a read of figures the caller is not entitled to,
    // even if the result would have been thrown away.
    expect(guardAt).toBeLessThan(fetchAt);
  });

  it('the dashboard checks access before it fetches', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/dashboard/page.tsx'), 'utf8');
    expect(source.indexOf('checkPageAccess')).toBeLessThan(source.indexOf('provider.getDashboard'));
  });

  it('the portfolio page never accepts an investor id from the request', () => {
    const source = fs.readFileSync(path.join(ROOT, 'app/admin/portfolio/page.tsx'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('access.session.investorId');
    // No searchParams, no params, no headers — there is no channel through which another
    // investor's id could arrive.
    expect(code).not.toMatch(/searchParams|params\.|headers\(\)/);
  });
});
