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

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { BookingsWorkspace } from '@/components/operations/BookingsWorkspace';
import { BookingDetailDrawer, BOOKING_PARAM } from '@/components/operations/BookingDetailDrawer';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import {
  operationalReservationRows, operationalBookingDetail,
  RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS, DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS,
  type OperationalBookingDetail,
} from '@/lib/data/views/role-projections';
import { roleHasCapability, ROLES } from '@/lib/shared/roles';
import { resolveFilters } from '@/lib/shared/page-helpers';
import { isoToSerial } from '@/lib/shared/dates';
import { OCCUPANCY_STATUSES } from '@/lib/shared/domain';
import type { PropertyOption, ReservationRow } from '@/lib/data/providers/types';

import { readSource as read, codeOf } from './support/source';

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
    date: '2027-01-19', isOperationalDay: true, periodLabel: 'Jan 2027', month: '2027-01',
    checkInFields: FIELDS, checkOutFields: FIELDS,
    ...over,
  }));
}

/** One booking, resolved and projected exactly as the page does it. */
async function detailFor(bookingId: string): Promise<OperationalBookingDetail | null> {
  const { data } = await provider.getBookingDetail(bookingId);
  return data ? operationalBookingDetail(data) : null;
}

async function firstBookingId(): Promise<string> {
  return (await bookings())[0]!.bookingId;
}

/** The drawer, wired the way the page wires it. */
function renderDetail(detail: OperationalBookingDetail | null, requestedId: string) {
  return renderUi(
    createElement(BookingDetailDrawer, { detail, requestedId }),
    `${BOOKING_PARAM}=${requestedId}`,
  );
}

/** Read a labelled fact out of the rendered panel. */
function factOf(container: HTMLElement, label: string): string {
  const dt = [...container.querySelectorAll('.sv-bkdetail__fact dt')]
    .find((el) => el.textContent === label);
  if (!dt) throw new Error(`no fact labelled "${label}" in the panel`);
  return dt.nextElementSibling?.textContent ?? '';
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
    const src = codeOf(read('components/operations/BookingsWorkspace.tsx'));
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

/* ================================================================== *
 * MILESTONE 4 . THE BOOKING DETAIL, AT ITS OWN ADDRESS
 * ================================================================== */

describe('bookings workspace . the detail panel', () => {
  it('opens from the URL alone, so a pasted link works', async () => {
    const id = await firstBookingId();
    const { container } = renderDetail(await detailFor(id), id);

    const drawer = container.querySelector('.sv-drawer');
    expect(drawer).toBeTruthy();
    expect(drawer).toHaveAttribute('aria-modal', 'true');
    expect(drawer!.getAttribute('aria-label')).toContain(id);
  });

  it('is closed when the URL does not ask for a booking', () => {
    const { container } = renderUi(
      createElement(BookingDetailDrawer, { detail: null, requestedId: undefined }),
    );
    expect(container.querySelector('.sv-drawer')).toBeNull();
  });

  it('resolves a booking OUTSIDE the reporting month — a link must work from anywhere', async () => {
    // The list is month-scoped; a detail link is not. A booking from an earlier period
    // still opens, which is the whole point of addressing one by reference.
    const months = await provider.getAvailableMonths();
    const early = (await provider.getReservations({ month: months[0]! })).data[0]!;
    const current = await latestMonth();

    expect(months[0]).not.toBe(current);
    expect((await bookings()).map((r) => r.bookingId)).not.toContain(early.bookingId);

    const detail = await detailFor(early.bookingId);
    expect(detail).not.toBeNull();
    expect(detail!.bookingId).toBe(early.bookingId);
  });

  it('says so in words when the reference names nothing', async () => {
    expect(await detailFor('BK-9999-9999')).toBeNull();

    const { container } = renderDetail(null, 'BK-9999-9999');
    expect(within(container).getByText('No booking BK-9999-9999')).toBeInTheDocument();
    expect(container.textContent).toContain('Check the booking ID');
    // Not an empty panel pretending to be a booking.
    expect(container.querySelector('.sv-bkdetail')).toBeNull();
  });

  it('carries the sections a front office needs, in order', async () => {
    const id = await firstBookingId();
    const { container } = renderDetail(await detailFor(id), id);
    const headings = [...container.querySelectorAll('.sv-bkdetail__heading')]
      .map((h) => h.textContent);
    /* UI-7 added the unit's own live state as a fifth section. It is LAST and it is
       titled for the unit, not the stay: the workbook holds no booking-to-turnover link
       the domain reads, so it must not read as something this booking caused. */
    expect(headings).toEqual(['Booking', 'Guest', 'Stay', 'Operations', 'This unit, right now']);
  });

  it('shows the stay facts the list has no room for', async () => {
    const id = await firstBookingId();
    const row = (await bookings()).find((r) => r.bookingId === id)!;
    const detail = await detailFor(id);
    const { container } = renderDetail(detail, id);

    expect(factOf(container, 'Reference')).toBe(id);
    expect(factOf(container, 'Platform')).toBe(row.platform);
    expect(factOf(container, 'Unit ID')).toBe(row.propertyId);
    expect(factOf(container, 'Nights')).toBe(String(row.nights));
    expect(factOf(container, 'Guests in total')).toBe(String(detail!.guests));
  });

  it('distinguishes NOT RECORDED from NO — an unchecked room is not a clean one', async () => {
    const id = await firstBookingId();
    const base = (await detailFor(id))!;

    // Nothing recorded: the panel says nobody looked.
    const absent = renderDetail({ ...base, maintenanceRequired: null, damageReport: null }, id);
    expect(factOf(absent.container, 'Maintenance required')).toBe('Not recorded');
    expect(factOf(absent.container, 'Damage report')).toBe('Not recorded');
    cleanup();

    // Recorded as no: somebody inspected and found nothing.
    const checked = renderDetail({ ...base, maintenanceRequired: false }, id);
    expect(factOf(checked.container, 'Maintenance required')).toBe('No');
    cleanup();

    const flagged = renderDetail({ ...base, maintenanceRequired: true }, id);
    expect(factOf(flagged.container, 'Maintenance required')).toBe('Yes');
  });

  it('reads back the arrival time the check-in mutation writes', async () => {
    // CheckInTime was written by the check-in flow and read by nothing: the value went
    // into the workbook and out of the product's sight. This closes that loop.
    const id = await firstBookingId();
    const base = (await detailFor(id))!;

    const withTime = renderDetail({ ...base, checkInTime: '14:20', checkOutTime: '10:05' }, id);
    expect(factOf(withTime.container, 'Arrived at')).toBe('14:20');
    expect(factOf(withTime.container, 'Departed at')).toBe('10:05');
    cleanup();

    const without = renderDetail({ ...base, checkInTime: null, checkOutTime: null }, id);
    expect(factOf(without.container, 'Arrived at')).toBe('Not recorded');
  });

  it('closing clears only the booking param and keeps the rest of the URL', async () => {
    const user = userEvent.setup();
    const id = await firstBookingId();
    const { container } = renderUi(
      createElement(BookingDetailDrawer, { detail: await detailFor(id), requestedId: id }),
      `scope=in-progress&${BOOKING_PARAM}=${id}&property=HYD-501`,
    );

    await user.click(within(container).getByRole('button', { name: /Close this panel/ }));
    // REPLACE, not back(): a reader who arrived on a pasted link must land on the list,
    // not be walked out of the application.
    const target = replaced.at(-1)!;
    expect(target).not.toContain(BOOKING_PARAM);
    expect(target).toContain('scope=in-progress');
    expect(target).toContain('property=HYD-501');
  });

  it('opens from a real link, so Back closes it and a middle-click opens a tab', async () => {
    const { container } = await workspace();
    const link = container.querySelector('a.sv-bklink') as HTMLAnchorElement;

    expect(link, 'the booking reference must be an anchor, not a click handler').toBeTruthy();
    expect(link.getAttribute('href')).toContain(`${BOOKING_PARAM}=`);
    // Named for a screen reader, not left as a bare code.
    expect(link.getAttribute('aria-label')).toMatch(/^Open booking BK-/);
  });

  it('keeps the current scope and filters in the link it builds', async () => {
    const rows = operationalReservationRows(await bookings());
    const { container } = renderUi(createElement(BookingsWorkspace, {
      rows, units: UNITS, scope: 'in-progress' as const,
      date: '2027-01-19', isOperationalDay: true, periodLabel: 'Jan 2027', month: '2027-01',
      checkInFields: FIELDS, checkOutFields: FIELDS,
    }), 'scope=in-progress&platform=Airbnb');

    const href = (container.querySelector('a.sv-bklink') as HTMLAnchorElement).getAttribute('href')!;
    expect(href).toContain('scope=in-progress');
    expect(href).toContain('platform=Airbnb');
    expect(href).toContain(`${BOOKING_PARAM}=`);
  });
});

/* ================================================================== *
 * WHAT THE DETAIL MUST NEVER CARRY
 * ================================================================== */

describe('bookings workspace . the detail panel carries no money and no full name', () => {
  it('has no financial field on the projected payload, for any booking', async () => {
    for (const row of await bookings()) {
      const detail = (await detailFor(row.bookingId))!;
      for (const withheld of DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS) {
        expect(Object.keys(detail), row.bookingId).not.toContain(withheld);
      }
      expect(JSON.stringify(detail)).not.toMatch(/payout|grossValue/i);
    }
  });

  it('withholds exactly the same fields as the list row — one rule, not two', () => {
    expect([...DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS])
      .toEqual([...RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS]);
  });

  it('is guarded at COMPILE time, not by review', () => {
    const src = read('lib/data/views/role-projections.ts');
    expect(src).toContain('OPERATIONAL_BOOKING_DETAIL_CARRIES_NO_FINANCIAL_FIELD');
    // A fresh literal, field by field. A spread would carry every future money column.
    const fn = src.slice(src.indexOf('export function operationalBookingDetail'));
    expect(fn.slice(0, fn.indexOf('}\n'))).not.toContain('...row');
  });

  it('renders no amount and no payout status in the panel', async () => {
    const id = await firstBookingId();
    const { container } = renderDetail(await detailFor(id), id);
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/₹|INR/);
    expect(text).not.toMatch(/\d{1,3}(,\d{2,3})+/);
    expect(text).not.toMatch(/payout/i);
  });

  it('shows only the minimised guest name — no full name reaches the panel', async () => {
    const id = await firstBookingId();
    const detail = (await detailFor(id))!;
    expect(detail.guestDisplayName).toMatch(/^\S+(\s\S\.)?$/);
    expect(Object.keys(detail)).not.toContain('guestName');

    // Scanned as CODE: the file's own comment explains that contact details are never
    // carried, and prose about a rule must not fail the rule's guard.
    const src = codeOf(read('components/operations/BookingDetailDrawer.tsx'));
    expect(src).not.toMatch(/guestName|fullName|email|phone|contact/i);
  });

  it('decides nothing about disclosure in the client', () => {
    const src = codeOf(read('components/operations/BookingDetailDrawer.tsx'));
    // No capability check, no role branch: the server sent a projection, and a client
    // that never receives a field cannot leak it however this file is later edited.
    expect(src).not.toMatch(/roleHasCapability|roleSeesFinancialFigures|capabilit/i);
    expect(src).toContain('OperationalBookingDetail');
  });

  it('the page projects the detail on the server, with no capability branch', () => {
    const src = read('app/admin/operations/reservations/page.tsx');
    expect(src).toContain('operationalBookingDetail(detail.data)');
    expect(src).not.toContain('roleSeesFinancialFigures');
  });

  it('an investor can reach neither the workspace nor a booking within it', () => {
    // The panel has no per-booking owner concept; the page capability is the control.
    expect(roleHasCapability('INVESTOR', 'reservations.read')).toBe(false);
    for (const role of ROLES) {
      if (role === 'INVESTOR') continue;
      expect(roleHasCapability(role, 'reservations.read'), role).toBe(true);
    }
    expect(read('app/admin/operations/reservations/page.tsx'))
      .toContain('capability="reservations.read"');
  });
});
