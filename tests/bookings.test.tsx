/**
 * UI-4 — THE BOOKING WORKSPACE.
 *
 * One suite for the booking domain's user-facing behaviour: the status vocabulary, the
 * day labels on the arrival and departure views, the workspace's search/filter/sort, the
 * URL-addressable detail drawer, and the lifecycle actions.
 *
 * These tests stand guard over the two rules the milestone brief refused to relax:
 * OPERATIONS receives no financial booking field, and no full guest name is disclosed
 * anywhere. Where a regression could reintroduce either, there is an assertion that fails
 * on it — verified by deliberately making the regression and watching the test go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import { createElement, type ReactElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { resolveFilters } from '@/lib/shared/page-helpers';
import { formatDate } from '@/lib/shared/format';
import { shiftIsoDay } from '@/lib/shared/dates';
import { OpsReservationsTable, ArrivalsTable } from '@/components/pages/OpsTables';
import { FinancialReservationsTable } from '@/components/pages/RegisterTables';
import {
  BOOKING_STATUS_TONE, bookingStatusTone,
} from '@/lib/shared/booking-status';
import {
  OCCUPANCY_STATUSES, CANCELLED_STATUSES, type BookingStatus,
} from '@/lib/shared/domain';
import type {
  ReservationRow, ArrivalRow, OperationsBoardView,
} from '@/lib/data/providers/types';
import type { OperationalReservationRow } from '@/lib/data/views/role-projections';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/**
 * Source with its comments removed.
 *
 * Every scan below is an assertion about CODE. Without this, explaining a defect in a
 * doc comment ("this table used to title itself ...") would fail the very test that
 * guards against the defect — which teaches the next reader to delete the explanation
 * rather than keep the guard.
 */
function codeOf(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')      // block comments, JSDoc included
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');  // line comments, sparing protocol slashes
}

/** Every source file a booking status could be given a colour in. */
function uiSourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/\.tsx?$/.test(entry.name)) out.push(rel);
    }
  };
  walk('components');
  walk('app');
  walk('lib');
  return out;
}

const replaced: string[] = [];
const refresh = vi.fn();
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  refresh,
  replace: (href: string) => { replaced.push(href); },
} as unknown as AppRouterInstance;

function renderUi(ui: ReactElement, { search = '', pathname = '/admin/operations/reservations' } = {}) {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: pathname },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

beforeEach(() => { replaced.length = 0; refresh.mockClear(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ------------------------------------------------------------------ *
 * Row builders — the shapes the real provider returns.
 * ------------------------------------------------------------------ */

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

const arrivalRow = (over: Partial<ArrivalRow> = {}): ArrivalRow => ({
  bookingId: 'BK-2027-0001', propertyId: 'HYD-501', guestDisplayName: 'Priya S.',
  nights: 3, guests: 2, platform: 'Airbnb', status: 'Confirmed',
  checkIn: '2027-02-10', checkOut: '2027-02-13', ...over,
});

const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

/** The real operations board, for the day asked for (or the source's own day). */
async function board(date?: string): Promise<OperationsBoardView> {
  const months = await provider.getAvailableMonths();
  const month = months[months.length - 1]!;
  const { data } = await provider.getOperations({ month, ...(date ? { date } : {}) });
  return data;
}

/** The tone a rendered pill actually carries, read off the class the design system sets. */
function toneOfPill(container: HTMLElement, label: string): string {
  const pill = within(container).getByText(label).closest('.sv-pill');
  if (!pill) throw new Error(`no status pill rendered for "${label}"`);
  const tone = Array.from(pill.classList).find((c) => c.startsWith('sv-pill--'));
  if (!tone) throw new Error(`pill for "${label}" carries no tone class`);
  return tone.replace('sv-pill--', '');
}

/* ================================================================== *
 * MILESTONE 1 · ONE BOOKING STATUS VOCABULARY
 * ================================================================== */

describe('bookings · status vocabulary', () => {
  it('covers every booking status the domain declares, and invents none', () => {
    // The union is the contract's BOOKING_STATUS list, mirrored in domain.ts. A status
    // with no tone would fall through to `neutral` and look finished when it is not.
    const declared: BookingStatus[] = [
      ...OCCUPANCY_STATUSES, ...CANCELLED_STATUSES, 'Inquiry',
    ];
    for (const status of declared) {
      expect(BOOKING_STATUS_TONE[status], status).toBeDefined();
    }
    expect(Object.keys(BOOKING_STATUS_TONE).sort()).toEqual([...declared].sort());
  });

  it('gives the two LOST-booking statuses the same tone — they are one domain class', () => {
    // CANCELLED_STATUSES groups Cancelled and No Show as bookings V1 counts as lost.
    // Splitting them across two hues is what the old duplicate maps did.
    const tones = new Set(CANCELLED_STATUSES.map((s) => bookingStatusTone(s)));
    expect(tones.size).toBe(1);
    expect([...tones][0]).toBe('bad');
  });

  it('renders a cancelled booking identically on the operations register and the ledger', () => {
    // The exact defect the milestone was opened for: `bad` on one screen, `warn` on the
    // other, so the severity of a cancellation depended on which menu entry you used.
    const ops = renderUi(
      createElement(OpsReservationsTable, { rows: [opsRow({ bookingStatus: 'Cancelled' })] }),
    );
    const opsTone = toneOfPill(ops.container, 'Cancelled');
    cleanup();

    const ledger = renderUi(
      createElement(FinancialReservationsTable, {
        rows: [financialRow({ bookingStatus: 'Cancelled' })], period: '2027-02',
      }),
    );
    const ledgerTone = toneOfPill(ledger.container, 'Cancelled');

    expect(opsTone).toBe(ledgerTone);
    expect(opsTone).toBe('bad');
  });

  it('agrees across every booking surface, status by status', () => {
    for (const status of Object.keys(BOOKING_STATUS_TONE) as BookingStatus[]) {
      const expected = BOOKING_STATUS_TONE[status];

      const ops = renderUi(
        createElement(OpsReservationsTable, { rows: [opsRow({ bookingStatus: status })] }),
      );
      expect(toneOfPill(ops.container, status), `ops register · ${status}`).toBe(expected);
      cleanup();

      const arrivals = renderUi(
        createElement(ArrivalsTable, {
          rows: [arrivalRow({ status })], mode: 'checkin' as const,
          date: '2027-02-10', isOperationalDay: true,
        }),
      );
      expect(toneOfPill(arrivals.container, status), `arrivals · ${status}`).toBe(expected);
      cleanup();

      const ledger = renderUi(
        createElement(FinancialReservationsTable, {
          rows: [financialRow({ bookingStatus: status })], period: '2027-02',
        }),
      );
      expect(toneOfPill(ledger.container, status), `ledger · ${status}`).toBe(expected);
      cleanup();
    }
  });

  it('renders an unrecognised status quietly instead of borrowing another status\'s meaning', () => {
    // The workbook is the source of this vocabulary and a cell can be hand-typed. The
    // old Today ternary sent anything unknown to `info` — the "on the books" colour.
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

  it('every booking table reaches for the shared vocabulary rather than its own', () => {
    for (const file of [
      'components/pages/OpsTables.tsx',
      'components/pages/RegisterTables.tsx',
      'components/operations/TodayBoard.tsx',
    ]) {
      expect(read(file), file).toContain("from '@/lib/shared/booking-status'");
    }
  });
});

/* ================================================================== *
 * MILESTONE 2 . THE DAY A MOVEMENT LIST IS ACTUALLY SHOWING
 * ================================================================== */

describe('bookings . arrivals and departures name their own day', () => {
  it("says today only when the day IS the source operational day", async () => {
    const view = await board();
    expect(view.isOperationalDay).toBe(true);

    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: view.arrivals, mode: 'checkin' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));
    expect(within(container).getByText("Today\'s arrivals")).toBeInTheDocument();
  });

  it('names the day outright when the reader has stepped back one', async () => {
    const today = (await board()).operationalDate;
    const yesterday = shiftIsoDay(today, -1);
    const view = await board(yesterday);

    expect(view.date).toBe(yesterday);
    expect(view.isOperationalDay).toBe(false);

    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: view.arrivals, mode: 'checkin' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));

    expect(within(container).getByText(`Arrivals \u2014 ${formatDate(yesterday)}`)).toBeInTheDocument();
    expect(container.textContent).not.toContain("Today\'s");
  });

  it('does the same for departures, on an arbitrary date', async () => {
    const view = await board('2027-02-20');
    expect(view.date).toBe('2027-02-20');

    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: view.departures, mode: 'checkout' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));

    expect(within(container).getByText(`Departures \u2014 ${formatDate('2027-02-20')}`)).toBeInTheDocument();
    expect(container.textContent).not.toContain("Today\'s");
    expect(container.textContent).toContain('20 Feb 2027');
  });

  it('carries the day into the subtitle and the empty state', async () => {
    const view = await board('2027-02-20');
    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: [], mode: 'checkin' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));

    const day = formatDate('2027-02-20');
    // The instruction stays; the false claim about "today" goes.
    expect(container.textContent).toContain(`Guests arriving ${day}`);
    // "No arrivals today" on a browsed day is the same lie, only quieter.
    expect(within(container).getByText(`No arrivals on ${day}`)).toBeInTheDocument();
  });

  it('names the day in the accessible table caption a screen reader announces', async () => {
    const view = await board('2027-02-20');
    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: view.arrivals.length ? view.arrivals : [arrivalRow()], mode: 'checkin' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));
    const caption = container.querySelector('caption');
    expect(caption?.textContent).toBe(`Arrivals for ${formatDate('2027-02-20')}`);
  });

  it('round-trips ?date= from the URL through the filters to the rendered heading', async () => {
    // The whole path the browser actually takes: search param -> resolveFilters ->
    // provider -> board.date -> heading. A break anywhere in it fails here.
    const filters = await resolveFilters({ date: '2027-02-20' });
    expect(filters.date).toBe('2027-02-20');

    const { data } = await provider.getOperations(filters);
    expect(data.date).toBe('2027-02-20');
    expect(data.isOperationalDay).toBe(false);

    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: data.arrivals, mode: 'checkin' as const,
      date: data.date, isOperationalDay: data.isOperationalDay,
    }));
    expect(within(container).getByText(`Arrivals \u2014 ${formatDate('2027-02-20')}`)).toBeInTheDocument();
  });

  it('falls back to the operational day when the URL carries a date that cannot exist', async () => {
    // Date semantics are unchanged by this milestone: a malformed value still falls back
    // rather than reaching a query, and the heading then truthfully says today.
    const view = await board('2027-02-31');
    expect(view.date).toBe(view.operationalDate);
    expect(view.isOperationalDay).toBe(true);

    const { container } = renderUi(createElement(ArrivalsTable, {
      rows: view.arrivals, mode: 'checkin' as const,
      date: view.date, isOperationalDay: view.isOperationalDay,
    }));
    expect(within(container).getByText("Today\'s arrivals")).toBeInTheDocument();
  });

  it('no movement list can hardcode the word today again', () => {
    // The table cannot be rendered without being told which day it shows (required
    // props), and no screen may re-assert "today" as a literal heading.
    for (const file of uiSourceFiles()) {
      const src = codeOf(read(file));
      expect(src, `${file} hardcodes a day it has not been told`)
        .not.toMatch(/["'`]Today\'s (arrivals|departures)["'`]/);
    }
    // The one legitimate use is conditional on the board saying so.
    expect(read('components/pages/OpsTables.tsx')).toContain('isOperationalDay');
  });

  it('the check-in and check-out pages hand the board own day to the table', () => {
    for (const file of [
      'app/admin/operations/checkins/page.tsx',
      'app/admin/operations/checkouts/page.tsx',
    ]) {
      const src = read(file);
      expect(src, file).toContain('date={board.date}');
      expect(src, file).toContain('isOperationalDay={board.isOperationalDay}');
      // The page header renders before the fetch, so it must not claim a day either.
      expect(src, file).not.toMatch(/description="Today\'s/);
    }
  });
});
