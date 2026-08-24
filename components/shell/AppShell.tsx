'use client';
/**
 * APP SHELL — sidebar, header, mobile navigation.
 *
 * Role-aware navigation is a convenience: it hides what the signed-in role cannot use so
 * the menu stays short and honest. It is NOT a security control — every request is
 * checked again by the API guard, and the RBAC suite asserts that a hidden route is also
 * refused when called directly.
 *
 * Phase B1 changes, each fixing a verified defect:
 *   - exactly ONE navigation item is ever active: the item whose href is the LONGEST
 *     match for the pathname. Previously every item sharing an aliased href lit up
 *     together (four at once on Operations › Today).
 *   - the alert count comes from data (`alertCount` is supplied by the layout from the
 *     operations board) and the bell is a LINK to the operations screen, shown only to
 *     roles that can act on it. The hard-coded `4` on an inert button is gone.
 *   - the mobile drawer is genuinely modal: focus trapped, Escape closes, body scroll
 *     locked, and the rest of the page is `inert` while it is open.
 *   - emoji glyphs are replaced by the Srivillu icon set.
 */
import { useCallback, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { visibleNavigation, breadcrumbFor } from '@/lib/shared/navigation';
import { capabilitiesFor, type Capability, type Role } from '@/lib/shared/roles';
import { BRAND, NO_BRAND_ASSETS, type BrandAssetSet } from '@/lib/shared/brand';
import { Icon, NAV_ICONS } from '@/components/ui/icons';
import { useFocusTrap, useInertOutside } from '@/components/ui/focus';
import { ToastProvider } from '@/components/ui/toast';
import { SrivilluLogo, SrivilluMark } from './Logo';
import { EnvironmentStatus } from './EnvironmentStatus';
import type { DataMeta } from '@/lib/data/providers/types';
import type { PublicEnvironmentInfo } from '@/lib/shared/environment';

export interface SessionUser {
  name: string;
  email: string;
  role: Role;
}

export function AppShell({
  user, meta, environment, scenario, children, alertCount = 0, brandAssets = NO_BRAND_ASSETS,
}: {
  user: SessionUser;
  meta: DataMeta;
  /** Resolved on the server. The client renders this; it never works out where it is. */
  environment: PublicEnvironmentInfo;
  /**
   * The demonstration scenario currently showing, when there is one. Sits in the header so
   * whoever is presenting can see what is on screen and reach the switch in one click —
   * hunting through a menu mid-demonstration is exactly the wrong moment for it.
   */
  scenario?: { key: string; title: string } | null;
  children: React.ReactNode;
  /**
   * Count of items currently needing attention, COMPUTED BY THE SERVER from the
   * operations board. Zero (the default) renders no badge; the bell itself appears only
   * for roles that hold `operations.view`, because an alert you cannot act on is noise.
   */
  alertCount?: number;
  /** Resolved on the server; absent artwork falls back to the typographic lockup. */
  brandAssets?: BrandAssetSet;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const closeMobile = useCallback(() => setMobileOpen(false), []);

  // The drawer is modal only when it IS a drawer (below the desktop breakpoint it is
  // opened explicitly; at desktop widths mobileOpen stays false and none of this runs).
  useFocusTrap(sidebarRef, mobileOpen, { onClose: closeMobile });
  useInertOutside(sidebarRef, mobileOpen);

  const granted = new Set<Capability>(capabilitiesFor(user.role));
  const sections = visibleNavigation(
    (capability) => granted.has(capability),
    { demoControls: environment.demoControls },
  );
  const trail = breadcrumbFor(pathname);

  /*
   * DEFECT FIX #5 — one active item, decided by the LONGEST matching href across the
   * whole menu. Aliased items (several entries pointing at the same parent route) can
   * no longer light up together: `/admin/operations/today` activates "Today" alone,
   * because its href is a longer match than the three items pointing at
   * `/admin/operations`.
   */
  const matches = (href: string): boolean =>
    pathname === href || (href !== '/admin' && pathname.startsWith(`${href}/`));
  const activeHref = sections
    .flatMap((s) => s.items)
    .filter((item) => matches(item.href))
    .reduce<string | null>((best, item) => (best === null || item.href.length > best.length ? item.href : best), null);

  const showBell = granted.has('operations.view');

  return (
    <ToastProvider>
    <div className="sv-shell">
      <a className="sv-skip-link" href="#main">Skip to main content</a>

      {/* ---------- Sidebar ---------- */}
      <aside
        ref={sidebarRef}
        id="sv-primary-nav"
        className={`sv-sidebar ${mobileOpen ? 'sv-sidebar--open' : ''}`}
        aria-label="Primary navigation"
      >
        <div className="sv-sidebar__brand">
          <SrivilluLogo assets={brandAssets} />
        </div>

        <nav className="sv-nav">
          {sections.map((section) => (
            <div className="sv-nav__section" key={section.title}>
              <p className="sv-nav__section-title">{section.title}</p>
              <ul className="sv-nav__list">
                {section.items.map((item) => {
                  const active = item.href === activeHref;
                  const icon = NAV_ICONS[item.label];
                  return (
                    <li key={`${section.title}-${item.label}`}>
                      <Link
                        href={item.href}
                        className={`sv-nav__link ${active ? 'sv-nav__link--active' : ''}`}
                        aria-current={active ? 'page' : undefined}
                        onClick={closeMobile}
                      >
                        {icon ? <span className="sv-nav__icon"><Icon name={icon} size={18} /></span> : null}
                        <span className="sv-nav__label">{item.label}</span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div className="sv-sidebar__foot">
          <p className="sv-sidebar__foot-name">{BRAND.name}</p>
          <p className="sv-sidebar__foot-meta">{BRAND.city} · 4 units</p>
        </div>
      </aside>

      {mobileOpen ? (
        <button
          type="button"
          className="sv-scrim m-scrim-enter"
          aria-label="Close navigation"
          onClick={closeMobile}
        />
      ) : null}

      {/* ---------- Main column ---------- */}
      <div className="sv-main">
        <header className="sv-topbar">
          <button
            type="button"
            className="sv-topbar__menu"
            aria-label="Open navigation"
            aria-expanded={mobileOpen}
            aria-controls="sv-primary-nav"
            onClick={() => setMobileOpen((v) => !v)}
          >
            <SrivilluMark size={24} assets={brandAssets} />
            <Icon name="menu" size={20} />
          </button>

          <nav aria-label="Breadcrumb" className="sv-breadcrumb">
            <ol>
              {trail.map((crumb, i) => (
                <li key={crumb.href}>
                  {i < trail.length - 1
                    ? <Link href={crumb.href}>{crumb.label}</Link>
                    : <span aria-current="page">{crumb.label}</span>}
                </li>
              ))}
            </ol>
          </nav>

          <div className="sv-topbar__right">
            <EnvironmentStatus environment={environment} meta={meta} />

            {scenario ? (
              <Link className="sv-scenario-chip" href="/admin/demo" title="Change the demonstration scenario">
                <span className="sv-scenario-chip__label">Scenario</span>
                <span className="sv-scenario-chip__value">{scenario.title}</span>
              </Link>
            ) : null}

            {showBell ? (
              <Link
                href="/admin/operations/today"
                className="sv-topbar__icon"
                aria-label={alertCount > 0
                  ? `${alertCount} items need attention — open today's operations`
                  : "Nothing needs attention — open today's operations"}
              >
                <Icon name="bell" size={18} />
                {alertCount > 0 ? <span className="sv-topbar__count" aria-hidden="true">{alertCount}</span> : null}
              </Link>
            ) : null}

            <div className="sv-user">
              <span className="sv-user__text">
                <span className="sv-user__name">{user.name}</span>
                <span className="sv-user__role">{user.role.replace('_', ' ').toLowerCase()}</span>
              </span>
              {/* The avatar IS the switch-account control, so the affordance survives the
                  smallest screens where the "Switch" text is hidden. */}
              <a
                className="sv-user__signout"
                href="/signin"
                aria-label={`Signed in as ${user.name} — switch account`}
              >
                <span className="sv-user__avatar" aria-hidden="true">
                  {user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}
                </span>
                <span className="sv-user__switch">Switch</span>
              </a>
            </div>
          </div>
        </header>

        <main id="main" className="sv-content">{children}</main>
      </div>
    </div>
    </ToastProvider>
  );
}
