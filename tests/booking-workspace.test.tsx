/**
 * UI-4 — THE BOOKINGS WORKSPACE.
 *
 * The screen a front office actually stands in front of: find a booking, see where it
 * stands, take the next step. These tests cover the two halves separately, because they
 * live in different places and fail differently.
 *
 *   - SCOPE is a server decision. "Who is staying right now" cannot be answered by a
 *     month of arrivals, so the view gained a second selection rule; it is tested at the
 *     view layer, against the real fixture workbook, where the rule is written.
 *   - SEARCH, STATUS and SORT are client narrowing over rows already in hand. They are
 *     tested through the rendered component, because "already in hand" is the security
 *     property: nothing the workspace can search is anything the server did not send.
 *
 * The standing guarantees — no financial field, no full guest name — are asserted here
 * too, against the payload as well as the pixels.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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
import { BookingsWorkspace } from '@/components/operations/BookingsWorkspace';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { operationalReservationRows } from '@/lib/data/views/role-projections';
import { RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS } from '@/lib/data/views/role-projections';
import { resolveFilters } from '@/lib/shared/page-helpers';
import { isoToSerial } from '@/lib/shared/dates';
import { OCCUPANCY_STATUSES } from '@/lib/shared/domain';
import type { PropertyOption, ReservationRow } from '@/lib/data/providers/types';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

async function latestMonth(): Promise<string> {
  const months = await provider.getAvailableMonths();
  return months[months.length - 1]!;
}

async function bookings(over: Record<string, unknown> = {}): Promise<ReservationRow[]> {
  const month = await latestMonth();
  const { data } = await provider.getReservations({ month, ...over });
  return data;
}

const replaced: string[] = [];
const refresh = vi.fn();
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  refresh,
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

const UNITS: PropertyOption[] = [
  { id: 'HYD-501', name: '5th Floor — 2 BHK' },
  { id: 'HYD-502', name: '5th Floor — 3 BHK' },
  { id: 'HYD-601', name: '6th Floor — 2 BHK' },
  { id: 'HYD-602', name: '6th Floor — 3 BHK' },
];

const FIELDS = [{ name: 'checkInTime', label: 'Arrival time', type: 'time' as const }];

/** The workspace, wired the way the page wires it. */
async function workspace(over: Partial<Parameters<typeof BookingsWorkspace>[0]> = {}) {
  const rows = operationalReservationRows(await bookings());
  return renderUi(createElement(BookingsWorkspace, {
    rows, units: UNITS, scope: 'month' as const,
    date: '2027-01-19', isOperationalDay: true, periodLabel: 'Jan 2027',
    checkInFields: FIELDS, checkOutFields: FIELDS,
    cancelFields: [{ name: 'reason', label: 'Why?', type: 'textarea' as const, required: true }],
    ...over,
  }));
}

const bodyRows = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('tbody tr'));

const firstCellText = (container: HTMLElement, column = 0) =>
  bodyRows(container).map((tr) => tr.children[column]?.textContent ?? '');

beforeEach(() => { replaced.length = 0; refresh.mockClear(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * SCOPE — a server decision, tested where the rule lives
 * ================================================================== */

describe('bookings workspace · scope', () => {
  it('defaults to bookings ARRIVING in the reporting month', async () => {
    const month = await latestMonth();
    const rows = await bookings();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.checkIn?.slice(0, 7), row.bookingId).toBe(month);
    }
  });

  it('in-progress selects stays that COVER the day, not stays that start in the month', async () => {
    const month = await latestMonth();
    const day = `${month}-19`;
    const { data } = await provider.getReservations({ month, date: day, scope: 'in-progress' });

    expect(data.length).toBeGreaterThan(0);
    for (const row of data) {
      // The half-open interval the engine already uses for occupancy: arrival on or
      // before the day, departure strictly after it.
      expect(isoToSerial(row.checkIn!), `${row.bookingId} check-in`)
        .toBeLessThanOrEqual(isoToSerial(day));
      expect(isoToSerial(row.checkOut!), `${row.bookingId} check-out`)
        .toBeGreaterThan(isoToSerial(day));
      // Only real stays. A cancellation is not somebody standing in the building.
      expect(OCCUPANCY_STATUSES, `${row.bookingId} status`).toContain(row.bookingStatus);
    }
  });

  it('selects exactly the stays the rule describes, recomputed independently', async () => {
    // Every booking the fixture holds, gathered a month at a time, then filtered here by
    // the definition rather than by the code under test. If the view ever drifts from
    // "arrived on or before the day, leaves after it, and is a real stay", this fails.
    const months = await provider.getAvailableMonths();
    const all = new Map<string, ReservationRow>();
    for (const m of months) {
      for (const row of (await provider.getReservations({ month: m })).data) {
        all.set(row.bookingId, row);
      }
    }

    const month = await latestMonth();
    for (const d of ['02', '05', '12', '19', '27']) {
      const day = `${month}-${d}`;
      const expected = [...all.values()]
        .filter((r) => r.checkIn !== null && r.checkOut !== null
          && isoToSerial(r.checkIn) <= isoToSerial(day)
          && isoToSerial(day) < isoToSerial(r.checkOut)
          && (OCCUPANCY_STATUSES as readonly string[]).includes(r.bookingStatus))
        .map((r) => r.bookingId).sort();

      const actual = (await provider.getReservations({ month, date: day, scope: 'in-progress' }))
        .data.map((r) => r.bookingId).sort();

      expect(actual, day).toEqual(expected);
    }
  });

  it('shows guests already in the house, whom a day of arrivals cannot', async () => {
    // The gap the month scope leaves: on any given day most people in the building
    // arrived on an earlier one, so an arrivals list is not an occupancy list.
    const month = await latestMonth();
    const day = `${month}-19`;
    const staying = (await provider.getReservations({ month, date: day, scope: 'in-progress' })).data;
    const arrivingToday = staying.filter((r) => r.checkIn === day);

    expect(staying.length).toBeGreaterThan(arrivingToday.length);
    for (const row of staying.filter((r) => r.checkIn !== day)) {
      expect(isoToSerial(row.checkIn!), row.bookingId).toBeLessThan(isoToSerial(day));
    }
  });

  it('counts a same-day turnover once: the departing stay is no longer in progress', async () => {
    const month = await latestMonth();
    const day = `${month}-19`;
    const staying = (await provider.getReservations({ month, date: day, scope: 'in-progress' })).data;
    // check-out === the day means they leave that morning; the interval is half-open.
    expect(staying.some((r) => r.checkOut === day)).toBe(false);
  });

  it('refuses an impossible date instead of querying with it', async () => {
    const month = await latestMonth();
    const bad = (await provider.getReservations({ month, date: '2027-02-31', scope: 'in-progress' })).data;
    const fallback = (await provider.getReservations({ month, scope: 'in-progress' })).data;
    expect(bad.map((r) => r.bookingId)).toEqual(fallback.map((r) => r.bookingId));
  });

  it('narrows an unrecognised ?scope= to the safe default rather than passing it through', async () => {
    // A URL cannot introduce a scope the view has never heard of.
    for (const raw of ['everything', 'in progress', 'IN-PROGRESS', '']) {
      const filters = await resolveFilters({ scope: raw });
      expect(filters.scope, raw).toBe('month');
    }
    expect((await resolveFilters({ scope: 'in-progress' })).scope).toBe('in-progress');
  });

  it('the scope toggle writes the URL and clears it again — the server owns the selection', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();

    await user.click(within(container).getByRole('button', { name: /Staying today/ }));
    expect(replaced.at(-1)).toBe('/admin/operations/reservations?scope=in-progress');

    cleanup();
    const back = await workspace({ scope: 'in-progress' });
    await user.click(within(back.container).getByRole('button', { name: /Arriving in Jan 2027/ }));
    // Cleared, not set to the default: a URL should carry only what differs from it.
    expect(replaced.at(-1)).toBe('/admin/operations/reservations');
  });

  it('says plainly that the reporting month does not apply while showing stays', async () => {
    const { container } = await workspace({ scope: 'in-progress' });
    expect(container.textContent).toContain('The reporting month does not apply');
  });

  it('names the scope the same way in the chip and in the table caption', async () => {
    // One phrasing, so a screen reader and a sighted reader hear the same screen.
    // "today" is already an adverb; only a date takes the preposition.
    const today = await workspace({ scope: 'in-progress', isOperationalDay: true });
    expect(today.container.querySelector('caption')?.textContent).toBe('Bookings — Staying today');
    expect(within(today.container).getByRole('button', { name: 'Staying today' })).toBeInTheDocument();
    cleanup();

    const other = await workspace({
      scope: 'in-progress', isOperationalDay: false, date: '2027-02-20',
    });
    expect(other.container.querySelector('caption')?.textContent)
      .toBe('Bookings — Staying on 20 Feb 2027');
    expect(within(other.container).getByRole('button', { name: 'Staying on 20 Feb 2027' }))
      .toBeInTheDocument();
  });
});

/* ================================================================== *
 * SEARCH — over rows already in hand, never a second read
 * ================================================================== */

describe('bookings workspace · search', () => {
  it('finds a booking by its reference', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    const target = bodyRows(container)[0]!.querySelector('code')!.textContent!;

    await user.type(screen.getByRole('searchbox', { name: /Search bookings/ }), target);
    expect(bodyRows(container)).toHaveLength(1);
    expect(container.textContent).toContain(target);
  });

  it('finds a booking by the guest name the list actually shows', async () => {
    const user = userEvent.setup();
    const rows = operationalReservationRows(await bookings());
    const guest = rows[0]!.guestDisplayName;
    const expected = rows.filter((r) => r.guestDisplayName === guest).length;
    const { container } = await workspace();

    await user.type(screen.getByRole('searchbox', { name: /Search bookings/ }), guest);
    expect(bodyRows(container)).toHaveLength(expected);
  });

  it('finds bookings by the unit NAME a person would say out loud', async () => {
    const user = userEvent.setup();
    const rows = operationalReservationRows(await bookings());
    const expected = rows.filter((r) => r.propertyId === 'HYD-501').length;
    expect(expected).toBeGreaterThan(0);

    const { container } = await workspace();
    await user.type(screen.getByRole('searchbox', { name: /Search bookings/ }), '5th Floor — 2 BHK');
    expect(bodyRows(container)).toHaveLength(expected);
  });

  it('matches case-insensitively and ignores surrounding space', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    const box = screen.getByRole('searchbox', { name: /Search bookings/ });

    await user.type(box, '  hyd-501  ');
    const lower = bodyRows(container).length;
    await user.clear(box);
    await user.type(box, 'HYD-501');
    expect(bodyRows(container)).toHaveLength(lower);
    expect(lower).toBeGreaterThan(0);
  });

  it('searches ONLY fields the row displays — a hidden matchable field is a hidden disclosure', () => {
    const src = read('components/operations/BookingsWorkspace.tsx');
    const searched = src.slice(src.indexOf('return ['), src.indexOf('].some(('));
    for (const field of ['row.bookingId', 'row.guestDisplayName', 'row.propertyId', 'row.platform']) {
      expect(searched, field).toContain(field);
    }
    // The projection has no such fields, so this is belt and braces over the type guard.
    for (const withheld of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(searched, withheld).not.toContain(withheld);
    }
  });

  it('offers a way out of an over-narrowed list instead of an empty screen', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();

    await user.type(screen.getByRole('searchbox', { name: /Search bookings/ }), 'zzzzz-no-such-guest');
    expect(within(container).getByText('No bookings match')).toBeInTheDocument();

    await user.click(within(container).getByRole('button', { name: /Clear search and filters/ }));
    expect(bodyRows(container).length).toBeGreaterThan(0);
  });

  it('distinguishes "nothing here" from "nothing matches"', async () => {
    const { container } = await workspace({ rows: [] });
    expect(within(container).getByText('No bookings this month')).toBeInTheDocument();
    // No clear-filters button: there is nothing to clear, and offering one would be a lie.
    expect(within(container).queryByRole('button', { name: /Clear search/ })).toBeNull();
  });
});

/* ================================================================== *
 * STATUS FILTER
 * ================================================================== */

describe('bookings workspace · status filter', () => {
  it('offers only statuses that are actually present, with their real counts', async () => {
    const rows = operationalReservationRows(await bookings());
    const present = new Set(rows.map((r) => r.bookingStatus));
    const { container } = await workspace();
    const group = within(container).getByRole('group', { name: 'Filter by status' });

    for (const status of present) {
      const chip = within(group).getByRole('button', { name: new RegExp(`^${status}`) });
      const count = rows.filter((r) => r.bookingStatus === status).length;
      expect(chip.textContent, status).toContain(String(count));
    }
    // No chip for a status nobody has — an empty filter is furniture, not information.
    for (const absent of ['Inquiry', 'No Show'].filter((s) => !present.has(s))) {
      expect(within(group).queryByRole('button', { name: new RegExp(`^${absent}`) })).toBeNull();
    }
  });

  it('narrows the list to one status and says how many of how many are showing', async () => {
    const user = userEvent.setup();
    const rows = operationalReservationRows(await bookings());
    const status = rows[0]!.bookingStatus;
    const expected = rows.filter((r) => r.bookingStatus === status).length;

    const { container } = await workspace();
    const group = within(container).getByRole('group', { name: 'Filter by status' });
    await user.click(within(group).getByRole('button', { name: new RegExp(`^${status}`) }));

    expect(bodyRows(container)).toHaveLength(expected);
    expect(container.textContent).toContain(`${expected} of ${rows.length}`);
  });

  it('announces which filter is applied through aria-pressed, not colour alone', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    const group = within(container).getByRole('group', { name: 'Filter by status' });
    const all = within(group).getByRole('button', { name: /^All/ });
    expect(all).toHaveAttribute('aria-pressed', 'true');

    const other = within(group).getAllByRole('button').find((b) => b !== all)!;
    await user.click(other);
    expect(other).toHaveAttribute('aria-pressed', 'true');
    expect(all).toHaveAttribute('aria-pressed', 'false');
  });
});

/* ================================================================== *
 * SORT
 * ================================================================== */

describe('bookings workspace · sort', () => {
  it('opens on check-in ascending — the register’s existing convention', async () => {
    const { container } = await workspace();
    const header = within(container).getByRole('columnheader', { name: /Check-in/ });
    expect(header).toHaveAttribute('aria-sort', 'ascending');

    // Compared as ISO, not as the printed short date: "10 Jan" sorts before "2 Jan"
    // as text, which would make a correct list look broken (and a broken one pass).
    const rows = operationalReservationRows(await bookings());
    const expected = [...rows]
      .sort((a, b) => (a.checkIn ?? '').localeCompare(b.checkIn ?? '')
        || a.bookingId.localeCompare(b.bookingId))
      .map((r) => r.bookingId);
    const shown = bodyRows(container).map((tr) => tr.querySelector('code')!.textContent!);
    expect(shown).toEqual(expected);
  });

  it('flips direction when the active column is pressed again', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    await user.click(within(container).getByRole('button', { name: /Check-in/ }));

    expect(within(container).getByRole('columnheader', { name: /Check-in/ }))
      .toHaveAttribute('aria-sort', 'descending');
  });

  it('sorts by guest, unit and check-out on request', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();

    await user.click(within(container).getByRole('button', { name: /Guest/ }));
    const guests = firstCellText(container, 1);
    expect(guests).toEqual([...guests].sort((a, b) => a.localeCompare(b)));

    await user.click(within(container).getByRole('button', { name: /^Unit/ }));
    expect(within(container).getByRole('columnheader', { name: /^Unit/ }))
      .toHaveAttribute('aria-sort', 'ascending');

    await user.click(within(container).getByRole('button', { name: /Check-out/ }));
    expect(within(container).getByRole('columnheader', { name: /Check-out/ }))
      .toHaveAttribute('aria-sort', 'ascending');
  });

  it('sorts status by the LIFECYCLE, not the alphabet', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    await user.click(within(container).getByRole('button', { name: /Status/ }));

    const order = ['Inquiry', 'Confirmed', 'Checked In', 'Checked Out', 'Cancelled', 'No Show'];
    const shown = firstCellText(container, 5).map((t) => t.trim());
    const ranks = shown.map((s) => order.indexOf(s));
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    // Alphabetical would put Cancelled before Confirmed. The lifecycle does not.
    if (shown.includes('Cancelled') && shown.includes('Confirmed')) {
      expect(shown.indexOf('Confirmed')).toBeLessThan(shown.indexOf('Cancelled'));
    }
  });

  it('every sortable header is a real button a keyboard can reach', async () => {
    const user = userEvent.setup();
    const { container } = await workspace();
    const button = within(container).getByRole('button', { name: /Guest/ });

    button.focus();
    await user.keyboard('{Enter}');
    expect(within(container).getByRole('columnheader', { name: /Guest/ }))
      .toHaveAttribute('aria-sort', 'ascending');
  });

  it('leaves every other table in the product unsorted — the capability is opt-in', () => {
    // DataTable is shared. A default-on sort would change eleven screens at once.
    const src = read('components/ui/DataTable.tsx');
    expect(src).toContain('column.sortable === true && onSort !== undefined');
    expect(src).toMatch(/sort\?: SortState/);
  });
});

/* ================================================================== *
 * THE STANDING GUARANTEES
 * ================================================================== */

describe('bookings workspace · what it must never carry', () => {
  it('receives no financial field in its payload at all', async () => {
    const rows = operationalReservationRows(await bookings());
    for (const row of rows) {
      for (const withheld of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
        expect(Object.keys(row), row.bookingId).not.toContain(withheld);
      }
    }
    const serialised = JSON.stringify(rows);
    for (const withheld of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(serialised).not.toContain(withheld);
    }
  });

  it('renders no money: no currency, no amount, no withheld field', async () => {
    const { container } = await workspace();
    const text = container.textContent ?? '';

    expect(text).not.toMatch(/₹|INR|\bRs\.?\b/);
    // No grouped thousands anywhere — the shape every amount on this product takes.
    expect(text).not.toMatch(/\d{1,3}(,\d{2,3})+/);
    for (const withheld of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(text.toLowerCase(), withheld).not.toContain(withheld.toLowerCase());
    }

    // The one sentence naming money is a SIGNPOST, not a figure: it tells a reader with
    // finance access where the numbers are, and tells one without why they are absent.
    expect(text).toContain('Payouts and revenue live on the finance screens');
  });

  it('shows the minimised guest name and never a full one', async () => {
    const rows = operationalReservationRows(await bookings());
    for (const row of rows) {
      // "Priya S." — a given name and a last initial, produced upstream in the view.
      expect(row.guestDisplayName, row.bookingId).toMatch(/^\S+(\s\S\.)?$/);
    }
    const src = read('components/operations/BookingsWorkspace.tsx');
    expect(src).not.toMatch(/guestName|GuestName|fullName/);
  });

  it('takes the projected row type, so a financial column is a compile error not a review note', () => {
    const src = read('components/operations/BookingsWorkspace.tsx');
    expect(src).toContain('OperationalReservationRow');
    expect(src).not.toContain("from '@/lib/data/providers/types'\n  ReservationRow");
  });

  it('the page projects before rendering, for every role, with no capability branch', () => {
    const src = read('app/admin/operations/reservations/page.tsx');
    expect(src).toContain('operationalReservationRows(rows)');
    // A branch here would mean a configuration of this screen that shows money.
    expect(src).not.toContain('roleSeesFinancialFigures');
  });
});
