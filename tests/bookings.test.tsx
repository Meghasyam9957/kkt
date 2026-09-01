/**
 * UI-4 — THE BOOKING VOCABULARY AND THE CONSOLIDATED ROUTES.
 *
 * Two things this suite holds still:
 *
 *   1. ONE status vocabulary. Three implementations of the status-to-tone map existed
 *      and two disagreed about a cancellation, so the severity of a booking depended on
 *      which menu entry you had used to look at it.
 *   2. ONE rendering of each booking concept. `/checkins`, `/checkouts` and the
 *      operational half of `/admin/reservations` were second renderings of screens that
 *      already existed; all three now hand the reader to the real one.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, within, cleanup } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { BookingsWorkspace } from '@/components/operations/BookingsWorkspace';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import { FinancialReservationsTable } from '@/components/pages/RegisterTables';
import { BOOKING_STATUS_TONE, bookingStatusTone } from '@/lib/shared/booking-status';
import { OCCUPANCY_STATUSES, CANCELLED_STATUSES, type BookingStatus } from '@/lib/shared/domain';
import { NAVIGATION, breadcrumbFor } from '@/lib/shared/navigation';
import type { ReservationRow, PropertyOption } from '@/lib/data/providers/types';
import type {
  OperationalReservationRow, OperationalBookingDetail,
} from '@/lib/data/views/role-projections';
import { readSource as read, codeOf, uiSourceFiles } from './support/source';

const replaced: string[] = [];
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  refresh: () => {},
  replace: (href: string) => { replaced.push(href); },
} as unknown as AppRouterInstance;

function renderUi(ui: ReactElement, search = '') {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/reservations' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

const UNITS: PropertyOption[] = [{ id: 'HYD-501', name: '5th Floor — 2 BHK' }];
const FIELDS = [{ name: 'checkInTime', label: 'Arrival time', type: 'time' as const }];

const opsRow = (over: Partial<OperationalReservationRow> = {}): OperationalReservationRow => ({
  bookingId: 'BK-2027-0001', platform: 'Airbnb', propertyId: 'HYD-501',
  bookingStatus: 'Confirmed', guestDisplayName: 'Priya S.',
  checkIn: '2027-02-10', checkOut: '2027-02-13', nights: 3, ...over,
});

const financialRow = (over: Partial<ReservationRow> = {}): ReservationRow => ({
  ...opsRow() as unknown as ReservationRow,
  grossValue: 24000, expectedPayout: 21000, actualPayout: 0, payoutStatus: 'Pending',
  ...over,
});

const detailRow = (over: Partial<OperationalBookingDetail> = {}): OperationalBookingDetail => ({
  ...opsRow(), platformRef: 'AI100001', unitName: '5th Floor — 2 BHK',
  adults: 2, children: 1, guests: 3, bookedOn: null,
  checkInTime: null, checkOutTime: null, earlyCheckIn: null, lateCheckout: null,
  guestVerification: null, damageReport: null, maintenanceRequired: null, notes: null,
  ...over,
});

/** The tone a rendered pill actually carries, read off the class the design system sets. */
function toneOfPill(container: HTMLElement, label: string): string {
  // Scoped to pills: the status word can legitimately appear elsewhere on a screen.
  const pills = [...container.querySelectorAll('.sv-pill')]
    .filter((el) => el.textContent?.trim() === label);
  if (pills.length === 0) throw new Error(`no status pill rendered for "${label}"`);
  const tones = new Set(pills.map((pill) => {
    const tone = [...pill.classList].find((c) => c.startsWith('sv-pill--'));
    if (!tone) throw new Error(`pill for "${label}" carries no tone class`);
    return tone.replace('sv-pill--', '');
  }));
  if (tones.size > 1) throw new Error(`"${label}" rendered with ${tones.size} tones on one screen`);
  return [...tones][0]!;
}

/** Every surface in the product that renders a booking's status. */
function renderEverySurface(status: BookingStatus): Array<{ where: string; tone: string }> {
  const out: Array<{ where: string; tone: string }> = [];

  const workspace = renderUi(createElement(BookingsWorkspace, {
    rows: [opsRow({ bookingStatus: status })], units: UNITS, scope: 'month' as const,
    date: '2027-02-19', isOperationalDay: true, periodLabel: 'Feb 2027',
    checkInFields: FIELDS, checkOutFields: FIELDS,
  }));
  out.push({ where: 'workspace', tone: toneOfPill(workspace.container, status) });
  cleanup();

  const detail = renderUi(createElement(BookingDetailDrawer, {
    detail: detailRow({ bookingStatus: status }), requestedId: 'BK-2027-0001',
  }));
  out.push({ where: 'detail panel', tone: toneOfPill(detail.container, status) });
  cleanup();

  const ledger = renderUi(createElement(FinancialReservationsTable, {
    rows: [financialRow({ bookingStatus: status })], period: '2027-02',
  }));
  out.push({ where: 'booking ledger', tone: toneOfPill(ledger.container, status) });
  cleanup();

  return out;
}

beforeEach(() => { replaced.length = 0; cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * ONE BOOKING STATUS VOCABULARY
 * ================================================================== */

describe('bookings · status vocabulary', () => {
  it('covers every booking status the domain declares, and invents none', () => {
    const declared: BookingStatus[] = [...OCCUPANCY_STATUSES, ...CANCELLED_STATUSES, 'Inquiry'];
    for (const status of declared) {
      expect(BOOKING_STATUS_TONE[status], status).toBeDefined();
    }
    expect(Object.keys(BOOKING_STATUS_TONE).sort()).toEqual([...declared].sort());
  });

  it('gives the two LOST-booking statuses the same tone — they are one domain class', () => {
    const tones = new Set(CANCELLED_STATUSES.map((s) => bookingStatusTone(s)));
    expect(tones.size).toBe(1);
    expect([...tones][0]).toBe('bad');
  });

  it('agrees on every surface, status by status', () => {
    // The exact defect this was opened for: a cancellation read `bad` on the operations
    // register and `warn` on the finance ledger, so its severity depended on the route.
    for (const status of Object.keys(BOOKING_STATUS_TONE) as BookingStatus[]) {
      const expected = BOOKING_STATUS_TONE[status];
      for (const { where, tone } of renderEverySurface(status)) {
        expect(tone, `${where} · ${status}`).toBe(expected);
      }
    }
  });

  it('renders an unrecognised status quietly instead of borrowing another meaning', () => {
    // The workbook owns this vocabulary and a cell can be hand-typed. The old Today
    // ternary sent anything unknown to `info` — the "on the books" colour.
    expect(bookingStatusTone('Provisional')).toBe('neutral');
    expect(bookingStatusTone('')).toBe('neutral');
  });

  it('no screen keeps a second booking status map', () => {
    // A tone literal on the same line as a booking status IS a map (or a ternary acting
    // as one). The only legitimate place for that pairing is the shared vocabulary.
    const STATUS = /'(Inquiry|Confirmed|Checked In|Checked Out|Cancelled|No Show)'/;
    const TONE = /'(good|warn|bad|info|neutral)'/;
    const offenders: string[] = [];

    for (const file of uiSourceFiles()) {
      if (file === 'lib/shared/booking-status.ts') continue;
      codeOf(read(file)).split('\n').forEach((line, i) => {
        if (STATUS.test(line) && TONE.test(line)) offenders.push(`${file}:${i + 1}`);
      });
    }
    expect(offenders).toEqual([]);
  });

  it('every booking surface reaches for the shared vocabulary rather than its own', () => {
    for (const file of [
      'components/operations/BookingsWorkspace.tsx',
      'components/operations/BookingDetailDrawer.tsx',
      'components/operations/TodayBoard.tsx',
      'components/pages/RegisterTables.tsx',
    ]) {
      expect(read(file), file).toContain("from '@/lib/shared/booking-status'");
    }
  });
});

/* ================================================================== *
 * ONE RENDERING PER BOOKING CONCEPT
 * ================================================================== */

describe('bookings · the duplicate screens are gone', () => {
  it('renders bookings in exactly two places: the workspace and the movements board', () => {
    // OpsReservationsTable was a second rendering of the workspace; ArrivalsTable was a
    // second rendering of half the Today board. Both drifted from the screens they
    // duplicated — about a cancellation's severity, and about which day they showed.
    const ops = read('components/pages/OpsTables.tsx');
    expect(ops).not.toContain('export function OpsReservationsTable');
    expect(ops).not.toContain('export function ArrivalsTable');

    // And nothing anywhere still reaches for them.
    for (const file of uiSourceFiles()) {
      const src = codeOf(read(file));
      expect(src, file).not.toMatch(/\bOpsReservationsTable\b/);
      expect(src, file).not.toMatch(/\bArrivalsTable\b/);
    }
  });

  it('keeps /checkins and /checkouts as routes — bookmarks must not break', () => {
    // Not deleted, redirected: the functionality moved to a screen that already did
    // more, and an old link still lands somewhere sensible.
    for (const file of [
      'app/admin/operations/checkins/page.tsx',
      'app/admin/operations/checkouts/page.tsx',
    ]) {
      const src = read(file);
      expect(src, file).toContain('redirect(');
      expect(src, file).toContain('/admin/operations/today');
      // The day and the property travel with the reader.
      expect(src, file).toContain("query.set('date'");
      expect(src, file).toContain("query.set('property'");
    }
  });

  it('sends a money-blind role to the workspace BEFORE reading a booking for them', () => {
    const src = read('app/admin/reservations/page.tsx');
    // The redirect is decided before ReadOnlyPage is even constructed, so no row from
    // this route is fetched on their behalf at all — stricter than projecting one.
    const redirectAt = src.indexOf('redirect(');
    const pageAt = src.indexOf('<ReadOnlyPage');
    expect(redirectAt).toBeGreaterThan(-1);
    expect(redirectAt).toBeLessThan(pageAt);
    expect(src).toContain('!roleSeesFinancialFigures(access.session.role)');
    expect(src).toContain('/admin/operations/reservations');
    // No second booking table under this route any more.
    expect(src).not.toContain('OpsReservationsTable');
  });

  it('drops the two menu entries that would now be aliases of Today', () => {
    const labels = NAVIGATION.flatMap((s) => s.items).map((i) => i.label);
    expect(labels).not.toContain('Check-ins');
    expect(labels).not.toContain('Check-outs');
    // Three labels pointing at one screen is the aliasing this menu was cleaned of.
    const hrefs = NAVIGATION.flatMap((s) => s.items).map((i) => i.href);
    expect(hrefs.filter((h) => h === '/admin/operations/today')).toHaveLength(1);
  });

  it('leaves exactly one menu entry per booking screen, each named for what it is', () => {
    const items = NAVIGATION.flatMap((s) => s.items);
    const booking = items.filter((i) => /reservations$/.test(i.href));
    expect(booking.map((i) => `${i.label} -> ${i.href}`).sort()).toEqual([
      'Booking Ledger -> /admin/reservations',
      'Bookings -> /admin/operations/reservations',
    ]);
    // The working screen is open to every role that works bookings; the money view
    // follows a financial capability.
    expect(items.find((i) => i.label === 'Bookings')!.capability).toBe('reservations.read');
    expect(items.find((i) => i.label === 'Booking Ledger')!.capability).toBe('revenue.read');
  });

  it('names the workspace the same way in the menu and in the breadcrumb', () => {
    // Before UI-4 the menu said "Bookings", the breadcrumb said "Bookings", and the
    // page heading said "Reservations" — one screen, two vocabularies.
    const trail = breadcrumbFor('/admin/operations/reservations');
    expect(trail.map((c) => c.label)).toEqual(['Admin', 'Operations', 'Bookings']);
    expect(read('app/admin/operations/reservations/page.tsx')).toContain('title="Bookings"');

    expect(breadcrumbFor('/admin/reservations').map((c) => c.label))
      .toEqual(['Admin', 'Booking Ledger']);
    expect(read('app/admin/reservations/page.tsx')).toContain('title="Booking Ledger"');
  });

  it('retires the word "Reservations" from every user-facing heading', () => {
    // Kept where it is real — the sheet, the route, the API, the capability — and gone
    // from the words a person reads.
    for (const file of [
      'app/admin/operations/reservations/page.tsx',
      'app/admin/reservations/page.tsx',
    ]) {
      const src = read(file);
      expect(src, file).not.toMatch(/title=["']Reservations["']/);
      expect(src, file).not.toMatch(/title: 'Reservations —/);
    }
    expect(NAVIGATION.flatMap((s) => s.items).map((i) => i.label))
      .not.toContain('Reservations');
  });
});
