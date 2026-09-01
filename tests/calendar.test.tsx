/**
 * UI-5 — THE AVAILABILITY CALENDAR.
 *
 * A calendar is an arithmetic screen pretending to be a visual one, so most of this suite
 * is about the arithmetic: the half-open interval, the month boundary, the blank date,
 * the same-day turnover. Those are the ways an availability grid lies — by showing a unit
 * free when somebody is in it, or held when nobody is.
 *
 * The rest holds two lines that must not move: OPERATIONS receives no financial field,
 * and no second occupancy definition is allowed to appear. A calendar that computed its
 * own availability would be a second answer to a question the engine already answers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, within, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { AvailabilityCalendar } from '@/components/operations/AvailabilityCalendar';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { WorkbookViews } from '@/lib/data/views/workbook-views';
import { buildDemoWorkbook, buildDemoOps } from '@/lib/data/fixtures/workbook';
import { spansDay, stayCoversDay } from '@/lib/server/analytics/kpi';
import {
  isoToSerial, daysOfMonth, weekdayOf, shiftMonthKey, resolveMonthKey, serialToDate,
} from '@/lib/shared/dates';
import { OCCUPANCY_STATUSES, type ReservationRecord } from '@/lib/shared/domain';
import { NAVIGATION } from '@/lib/shared/navigation';
import { roleHasCapability, ROLES } from '@/lib/shared/roles';
import { RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS } from '@/lib/data/views/role-projections';
import type { CalendarView } from '@/lib/data/providers/types';
import { readSource as read, codeOf } from './support/source';

const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

async function calendar(over: Record<string, unknown> = {}): Promise<CalendarView> {
  const { data } = await provider.getCalendar({ month: '2027-01', ...over });
  return data;
}

const refresh = vi.fn();
const replaced: string[] = [];
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  refresh,
  replace: (href: string) => { replaced.push(href); },
} as unknown as AppRouterInstance;

function renderUi(ui: ReactElement, search = '') {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/calendar' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

/** A booking record, for arithmetic that must not depend on which fixture rows exist. */
const stay = (over: Partial<ReservationRecord> = {}): ReservationRecord => ({
  BookingID: 'BK-2027-9001', Platform: 'Direct', PlatformResID: '', PropertyID: 'HYD-501',
  BookingDate: null, BookingStatus: 'Confirmed', GuestName: 'Test Guest',
  Adults: 2, Children: 0,
  CheckInDate: isoToSerial('2027-01-10'), CheckOutDate: isoToSerial('2027-01-13'),
  BaseRate: 0, RoomRevenue: 0, CleaningFee: 0, ExtraGuestFee: 0, OtherCharges: 0,
  Discount: 0, Taxes: 0, PlatformFee: 0, OtherDeductions: 0, ActualPayout: 0, PayoutDate: null,
  ...over,
});

/** A calendar built over a workbook whose reservations we control outright. */
function viewWith(reservations: ReservationRecord[], month = '2027-01'): CalendarView {
  const workbook = buildDemoWorkbook();
  // The same operational day the provider above uses, so "today" means one thing here.
  const ops = buildDemoOps('2027-01-19');
  const views = new WorkbookViews({ workbook: { ...workbook, reservations }, ops });
  return views.calendar({ month });
}

const stateOn = (view: CalendarView, propertyId: string, date: string) => {
  const unit = view.units.find((u) => u.propertyId === propertyId)!;
  return unit.cells.find((c) => c.date === date)!;
};

beforeEach(() => { replaced.length = 0; refresh.mockClear(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * 1 · DATE ARITHMETIC
 * ================================================================== */

describe('calendar · dates', () => {
  it('lists every day of a month, including a leap February', () => {
    expect(daysOfMonth('2027-02')).toHaveLength(28);
    expect(daysOfMonth('2028-02')).toHaveLength(29);
    expect(daysOfMonth('2027-01')).toHaveLength(31);
    expect(daysOfMonth('2027-04')).toHaveLength(30);
    expect(daysOfMonth('2027-01')[0]).toBe('2027-01-01');
    expect(daysOfMonth('2027-01').at(-1)).toBe('2027-01-31');
  });

  it('names weekdays the way a real calendar does', () => {
    // `serial % 7` is off by one against the sheet epoch, and a grid whose weekday
    // headers sit one column out is wrong in a way nobody spots until they book a
    // weekend. Checked against the module's own conversion, which is the definition.
    for (const iso of ['2027-01-01', '2027-02-19', '2026-04-01', '2028-02-29', '2026-12-25']) {
      expect(weekdayOf(iso), iso).toBe(serialToDate(isoToSerial(iso)).getUTCDay());
    }
  });

  it('steps months across a year boundary', () => {
    expect(shiftMonthKey('2027-01', -1)).toBe('2026-12');
    expect(shiftMonthKey('2027-12', 1)).toBe('2028-01');
    expect(shiftMonthKey('2027-02', 1)).toBe('2027-03');
  });

  it('refuses a month that cannot exist rather than querying with it', () => {
    for (const bad of ['2027-13', '2027-00', 'bad', '', '2027-2', null, undefined]) {
      expect(resolveMonthKey(bad, '2027-01'), String(bad)).toBe('2027-01');
    }
    expect(resolveMonthKey('2027-06', '2027-01')).toBe('2027-06');
  });

  it('shows a month with no bookings at all — a calendar is for looking ahead', async () => {
    // resolveMonth clamps to months carrying revenue, which is right for a P&L and
    // fatal here: stepping to next month would silently snap back to this one.
    const view = await calendar({ month: '2027-06' });
    expect(view.month).toBe('2027-06');
    expect(view.days).toHaveLength(30);
    expect(view.units.every((u) => u.cells.every((c) => c.state === 'available'))).toBe(true);
  });

  it('the page hands the RAW month past the clamping filter resolver', () => {
    const src = read('app/admin/operations/calendar/page.tsx');
    expect(src).toContain('month: params.month');
    // And does not offer a second month control that could disagree with its own.
    expect(src).toContain("filters={['property', 'platform']}");
  });
});

/* ================================================================== *
 * 2 · THE OCCUPANCY INTERVAL
 * ================================================================== */

describe('calendar · the half-open interval', () => {
  const day = (iso: string) => isoToSerial(iso);

  it('counts the arrival day and not the departure day', () => {
    const b = stay({ CheckInDate: day('2027-01-10'), CheckOutDate: day('2027-01-13') });
    expect(stayCoversDay(b, day('2027-01-09'))).toBe(false);
    expect(stayCoversDay(b, day('2027-01-10'))).toBe(true);
    expect(stayCoversDay(b, day('2027-01-12'))).toBe(true);
    expect(stayCoversDay(b, day('2027-01-13'))).toBe(false);
  });

  it('holds exactly one night for a one-night booking', () => {
    const view = viewWith([stay({ CheckInDate: day('2027-01-10'), CheckOutDate: day('2027-01-11') })]);
    expect(stateOn(view, 'HYD-501', '2027-01-10').state).toBe('booked');
    expect(stateOn(view, 'HYD-501', '2027-01-11').state).toBe('available');
    const bar = view.units.find((u) => u.propertyId === 'HYD-501')!.stays[0]!;
    expect(bar.span).toBe(1);
    expect(bar.fromDate).toBe('2027-01-10');
    expect(bar.toDate).toBe('2027-01-10');
  });

  it('lets a same-day turnover share the changeover date without overlapping', () => {
    const view = viewWith([
      stay({ BookingID: 'BK-A', CheckInDate: day('2027-01-10'), CheckOutDate: day('2027-01-12') }),
      stay({ BookingID: 'BK-B', CheckInDate: day('2027-01-12'), CheckOutDate: day('2027-01-14') }),
    ]);
    expect(stateOn(view, 'HYD-501', '2027-01-11').bookingId).toBe('BK-A');
    // The 12th belongs to the arriving guest, not the departing one.
    expect(stateOn(view, 'HYD-501', '2027-01-12').bookingId).toBe('BK-B');
    expect(stateOn(view, 'HYD-501', '2027-01-13').bookingId).toBe('BK-B');

    const bars = view.units.find((u) => u.propertyId === 'HYD-501')!.stays;
    expect(bars).toHaveLength(2);
    expect(bars[0]!.toDate).toBe('2027-01-11');
    expect(bars[1]!.fromDate).toBe('2027-01-12');
  });

  it('treats a blank date as absent, not as the epoch', () => {
    // A blank cell arrives as serial 0. Without the guard an unfinished booking occupies
    // every day since 1899, which paints the whole grid held.
    expect(spansDay(0, day('2027-01-13'), day('2027-01-10'))).toBe(false);
    expect(spansDay(day('2027-01-10'), 0, day('2027-01-10'))).toBe(false);
    expect(spansDay(null, null, day('2027-01-10'))).toBe(false);

    const view = viewWith([stay({ CheckInDate: 0, CheckOutDate: 0 })]);
    expect(view.units.every((u) => u.cells.every((c) => c.state === 'available'))).toBe(true);
  });

  it('leaves the unit FREE for a cancellation and a no-show', () => {
    for (const status of ['Cancelled', 'No Show']) {
      const view = viewWith([stay({ BookingStatus: status })]);
      expect(stateOn(view, 'HYD-501', '2027-01-11').state, status).toBe('available');
      expect(view.units.find((u) => u.propertyId === 'HYD-501')!.stays, status).toEqual([]);
    }
    // Because the domain says so, not because the calendar decided it.
    expect(OCCUPANCY_STATUSES).not.toContain('Cancelled');
    expect(OCCUPANCY_STATUSES).not.toContain('No Show');
  });

  it('paints an in-progress stay as in house, and a finished one as stayed', () => {
    const dates = { CheckInDate: day('2027-01-10'), CheckOutDate: day('2027-01-13') };
    expect(stateOn(viewWith([stay({ ...dates, BookingStatus: 'Confirmed' })]), 'HYD-501', '2027-01-11').state)
      .toBe('booked');
    expect(stateOn(viewWith([stay({ ...dates, BookingStatus: 'Checked In' })]), 'HYD-501', '2027-01-11').state)
      .toBe('checked-in');
    expect(stateOn(viewWith([stay({ ...dates, BookingStatus: 'Checked Out' })]), 'HYD-501', '2027-01-11').state)
      .toBe('checked-out');
  });

  it('keeps units apart — a booking holds ONE unit', () => {
    const view = viewWith([stay({ PropertyID: 'HYD-501' })]);
    expect(stateOn(view, 'HYD-501', '2027-01-11').state).toBe('booked');
    for (const other of ['HYD-502', 'HYD-601', 'HYD-602']) {
      expect(stateOn(view, other, '2027-01-11').state, other).toBe('available');
    }
  });

  it('clips a stay that crosses the month boundary, and says which end', () => {
    const view = viewWith([stay({
      CheckInDate: day('2026-12-28'), CheckOutDate: day('2027-02-03'),
    })]);
    const unit = view.units.find((u) => u.propertyId === 'HYD-501')!;
    // Every day of January is held, and the bar is one run across the whole month.
    expect(unit.cells.every((c) => c.bookingId === 'BK-2027-9001')).toBe(true);
    expect(unit.stays).toHaveLength(1);
    const bar = unit.stays[0]!;
    expect(bar.fromDate).toBe('2027-01-01');
    expect(bar.toDate).toBe('2027-01-31');
    expect(bar.span).toBe(31);
    expect(bar.continuesBefore).toBe(true);
    expect(bar.continuesAfter).toBe(true);
    // The bar reports the WHOLE stay, not the visible fragment.
    expect(bar.checkIn).toBe('2026-12-28');
    expect(bar.checkOut).toBe('2027-02-03');
  });

  it('does not claim to continue past a month it ends inside', () => {
    const view = viewWith([stay({
      CheckInDate: day('2027-01-29'), CheckOutDate: day('2027-02-01'),
    })]);
    const bar = view.units.find((u) => u.propertyId === 'HYD-501')!.stays[0]!;
    // Departure is 1 Feb, which is not occupied — so the stay ends inside January.
    expect(bar.toDate).toBe('2027-01-31');
    expect(bar.continuesAfter).toBe(false);
  });

  it('agrees with the engine: every painted day is a day the engine counts occupied', async () => {
    const view = await calendar({ month: '2027-01' });
    const workbook = buildDemoWorkbook();
    for (const unit of view.units) {
      for (const cell of unit.cells) {
        const engineSaysHeld = workbook.reservations.some((b) =>
          b.PropertyID === unit.propertyId && stayCoversDay(b, isoToSerial(cell.date)));
        expect(cell.state !== 'available', `${unit.propertyId} ${cell.date}`).toBe(engineSaysHeld);
      }
    }
  });

  it('builds no second occupancy definition anywhere', () => {
    // The interval was open-coded in four places before this milestone. One helper now,
    // and no screen re-derives availability in the browser.
    const view = codeOf(read('lib/data/views/workbook-views.ts'));
    expect(view).toContain('stayCoversDay');
    expect(view).not.toMatch(/CheckInDate <= \w+ && \w+ < .*CheckOutDate/);

    const client = codeOf(read('components/operations/AvailabilityCalendar.tsx'));
    expect(client).not.toMatch(/CheckInDate|CheckOutDate|isoToSerial/);
  });
});

/* ================================================================== *
 * 3 · WHAT THE SCREEN SHOWS
 * ================================================================== */

describe('calendar · the grid', () => {
  it('renders a unit per row and a day per column, as a real table', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));

    const rows = container.querySelectorAll('.sv-caltable tbody tr');
    expect(rows).toHaveLength(view.units.length);
    expect(container.querySelectorAll('.sv-caltable__day')).toHaveLength(view.days.length);
    // Row headers, not plain cells: a screen reader announces the unit with each stay.
    expect(container.querySelectorAll('th.sv-caltable__unit')).toHaveLength(view.units.length);
    expect(container.querySelector('.sv-caltable caption')?.textContent)
      .toContain('the arrival day counts, the departure day does not');
  });

  it('gives every booking bar a complete accessible name', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const bars = [...container.querySelectorAll('.sv-calbar')];
    expect(bars.length).toBeGreaterThan(0);

    for (const bar of bars) {
      const label = bar.getAttribute('aria-label')!;
      // A two-night bar is about 56px wide, so the pixels cannot carry this — the name
      // has to, or a keyboard user hears a coloured rectangle.
      expect(label).toMatch(/BK-\d{4}-\d{4}/);
      expect(label).toMatch(/night/);
      expect(label).toMatch(/Confirmed|Checked In|Checked Out/);
    }
  });

  it('spans a bar across exactly the nights it holds', async () => {
    const view = viewWith([stay({
      CheckInDate: isoToSerial('2027-01-10'), CheckOutDate: isoToSerial('2027-01-14'),
    })]);
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const bar = container.querySelector('.sv-calbar')!;
    expect(bar.closest('td')!.getAttribute('colspan')).toBe('4');
  });

  it('states a status in words, not only in colour', async () => {
    const view = viewWith([stay({
      CheckInDate: isoToSerial('2027-01-10'), CheckOutDate: isoToSerial('2027-01-15'),
      BookingStatus: 'Checked In',
    })]);
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    expect(container.querySelector('.sv-calbar__status')?.textContent).toBe('Checked In');
  });

  it('offers every free day as a labelled way to place a booking', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const free = container.querySelector('.sv-calfree')!;
    expect(free.getAttribute('aria-label')).toMatch(/is available on .+ — open bookings for this unit/);
    expect(free.getAttribute('href')).toMatch(/^\/admin\/operations\/reservations\?month=2027-01&property=HYD-/);
  });

  it('labels a unit the master flags out of service without erasing its bookings', () => {
    const workbook = buildDemoWorkbook();
    const blocked = workbook.properties.map((p, i) =>
      (i === 0 ? { ...p, PropertyStatus: 'Blocked' } : p));
    const views = new WorkbookViews({
      workbook: { ...workbook, properties: blocked, reservations: [stay()] },
      ops: buildDemoOps('2027-01-19'),
    });
    const view = views.calendar({ month: '2027-01' });

    const unit = view.units[0]!;
    expect(unit.outOfService).toBe(true);
    expect(unit.propertyStatus).toBe('Blocked');
    // The flag is UNDATED, so it must not paint days — a standing status that erased a
    // real booking would hide the guest who is actually arriving.
    expect(unit.cells.some((c) => c.state === 'booked')).toBe(true);
  });
});

/* ================================================================== *
 * 4 · INTERACTION
 * ================================================================== */

describe('calendar · interaction', () => {
  it('opens a booking at the SAME address the Bookings workspace uses', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const bar = container.querySelector('a.sv-calbar')!;
    const id = bar.getAttribute('aria-label')!.match(/BK-\d{4}-\d{4}/)![0];

    // A real link, so Back closes the panel and middle-click opens a tab.
    expect(bar.tagName).toBe('A');
    expect(bar.getAttribute('href')).toContain(`booking=${id}`);
  });

  it('reuses the one booking detail panel rather than growing a second', () => {
    const page = read('app/admin/operations/calendar/page.tsx');
    expect(page).toContain('BookingDetailDrawer');
    expect(page).toContain('operationalBookingDetail');
    // Same projection, same actions, same component as the workspace.
    expect(page).toContain('BookingActions');
    /*
     * And the RESOLVED projection is what the panel receives. Importing the drawer while
     * handing it nothing renders "booking not found" for every booking on the grid — a
     * screen that looks wired and answers wrongly, which is worse than one that fails.
     */
    expect(page).toMatch(/detail=\{projected\}/);
    expect(page).toMatch(/const projected = detail \? operationalBookingDetail\(detail\) : null/);
    const client = codeOf(read('components/operations/AvailabilityCalendar.tsx'));
    // The calendar imports one CONSTANT from the drawer module (the search-param
    // name) and renders no detail markup of its own — the panel arrives as a
    // server-rendered child, so there is nothing here to drift from the workspace.
    expect(client).not.toMatch(/sv-bkdetail/);
    expect(client).toContain("import { BOOKING_PARAM } from './BookingDetailDrawer'");
    expect(client).not.toMatch(/<BookingDetailDrawer|<Drawer/);
  });

  it('steps months and clears the day that belonged to the old one', async () => {
    const user = userEvent.setup();
    const view = await calendar();
    const { container } = renderUi(
      createElement(AvailabilityCalendar, { view }), 'month=2027-01&date=2027-01-19');

    await user.click(within(container).getByRole('button', { name: /Next month/ }));
    expect(replaced.at(-1)).toContain('month=2027-02');
    // Carrying 19 January into February would leave the day view describing a date the
    // grid does not show.
    expect(replaced.at(-1)).not.toContain('date=');
  });

  it('offers a way back only when the reader has left this month', async () => {
    const here = await calendar({ month: '2027-01' });
    const { container } = renderUi(createElement(AvailabilityCalendar, { view: here }));
    expect(within(container).queryByRole('button', { name: /Back to this month/ })).toBeNull();
    cleanup();

    const away = await calendar({ month: '2026-11' });
    const other = renderUi(createElement(AvailabilityCalendar, { view: away }));
    expect(within(other.container).getByRole('button', { name: /Back to this month/ })).toBeInTheDocument();
  });

  it('selects a day from the keyboard and keeps every other filter', async () => {
    const user = userEvent.setup();
    const view = await calendar();
    const { container } = renderUi(
      createElement(AvailabilityCalendar, { view }), 'month=2027-01&property=HYD-501');

    const dayButton = container.querySelectorAll('.sv-caltable__daybtn')[4] as HTMLElement;
    dayButton.focus();
    await user.keyboard('{Enter}');

    expect(replaced.at(-1)).toContain('date=2027-01-05');
    expect(replaced.at(-1)).toContain('property=HYD-501');
  });

  it('names every day control for someone who cannot see the column', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const buttons = [...container.querySelectorAll('.sv-caltable__daybtn')];
    expect(buttons).toHaveLength(31);
    expect(buttons[0]!.getAttribute('aria-label')).toBe('1 Jan 2027, Friday');
    // The source's own day is marked as such, in words.
    const today = container.querySelector('.sv-caltable__day--today .sv-caltable__daybtn');
    expect(today?.getAttribute('aria-label')).toContain('today');
  });
});

/* ================================================================== *
 * 5 · THE DAY VIEW (mobile)
 * ================================================================== */

describe('calendar · the day view', () => {
  it('is a different presentation, not the grid squeezed', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));

    // A day strip and a unit list — no 31-column table inside it.
    expect(container.querySelectorAll('.sv-calday__pip')).toHaveLength(view.days.length);
    expect(container.querySelectorAll('.sv-calrow')).toHaveLength(view.units.length);
    expect(container.querySelector('.sv-calday table')).toBeNull();
  });

  it('describes the selected day and every unit on it, in words', async () => {
    const view = viewWith([stay({
      CheckInDate: isoToSerial('2027-01-19'), CheckOutDate: isoToSerial('2027-01-22'),
      BookingStatus: 'Checked In',
    })]);
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const day = container.querySelector('.sv-calday');
    expect(within(day as HTMLElement).getByText('19 Jan 2027 — today')).toBeInTheDocument();

    const rows = [...container.querySelectorAll('.sv-calrow')];
    const held = rows.find((r) => r.textContent?.includes('In house'))!;
    expect(held.querySelector('.sv-calrow__name')?.textContent).toBe('5th Floor — 2 BHK');
    // The others say Available and offer the way to place one.
    expect(rows.filter((r) => r.textContent?.includes('Available'))).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByRole('link', { name: /is available on/ }))
      .toBeInTheDocument();
  });

  it('falls back to the first of the month when the selected day is elsewhere', async () => {
    // Browsing to another month must not leave the list describing a date off the grid.
    const view = await calendar({ month: '2026-11', date: '2027-01-19' });
    expect(view.selectedInMonth).toBe(false);
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    expect(container.querySelector('.sv-calday__heading')?.textContent).toBe('1 Nov 2026');
  });

  it('gives every day pip a 44px target and a spoken name', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const pip = container.querySelectorAll('.sv-calday__pip')[18]!;
    expect(pip.getAttribute('aria-label')).toBe('19 Jan 2027, Tuesday — today');
    expect(pip.getAttribute('aria-pressed')).toBe('true');
    // The 44px floor is a stylesheet rule, asserted where it is written.
    expect(read('styles/app.css')).toMatch(/\.sv-calday__pip[\s\S]{0,200}min-height: 44px/);
  });
});

/* ================================================================== *
 * 6 · WHAT IT MUST NEVER CARRY
 * ================================================================== */

describe('calendar · security', () => {
  it('has no financial field on the payload, for any unit or any day', async () => {
    const view = await calendar();
    const serialised = JSON.stringify(view);
    for (const withheld of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(serialised, withheld).not.toContain(withheld);
    }
    expect(serialised).not.toMatch(/baseRate|roomRevenue|cleaningFee|grossValue/i);
  });

  it('renders no currency and no amount', async () => {
    const view = await calendar();
    const { container } = renderUi(createElement(AvailabilityCalendar, { view }));
    const text = container.textContent ?? '';
    expect(text).not.toMatch(/₹|INR/);
    expect(text).not.toMatch(/\d{1,3}(,\d{2,3})+/);
    expect(text).not.toMatch(/payout|revenue/i);
  });

  it('shows the minimised guest name and never a full one', async () => {
    const view = await calendar();
    for (const unit of view.units) {
      for (const s of unit.stays) {
        expect(s.guestDisplayName, s.bookingId).toMatch(/^\S+(\s\S\.)?$/);
      }
    }
    const client = codeOf(read('components/operations/AvailabilityCalendar.tsx'));
    expect(client).not.toMatch(/guestName|fullName|email|phone|contact/i);
  });

  it('is guarded by the same capability as the register it draws', () => {
    const src = read('app/admin/operations/calendar/page.tsx');
    expect(src).toContain('capability="reservations.read"');
    // An investor holds it nowhere near, so the calendar is refused exactly as the
    // register is. Every role that works bookings may open it.
    expect(roleHasCapability('INVESTOR', 'reservations.read')).toBe(false);
    for (const role of ROLES) {
      if (role === 'INVESTOR') continue;
      expect(roleHasCapability(role, 'reservations.read'), role).toBe(true);
    }
  });

  it('appears once in the menu, under the capability it is guarded by', () => {
    const items = NAVIGATION.flatMap((s) => s.items);
    const entries = items.filter((i) => i.href === '/admin/operations/calendar');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('Availability');
    expect(entries[0]!.capability).toBe('reservations.read');
    // One calendar in the product: no other menu entry claims to be one.
    expect(items.filter((i) => /calendar/i.test(i.href))).toHaveLength(1);
  });

  it('is reachable from the two screens a front office already lives on', () => {
    expect(codeOf(read('components/operations/BookingsWorkspace.tsx')))
      .toContain('/admin/operations/calendar');
    expect(codeOf(read('components/operations/TodayBoard.tsx')))
      .toContain('/admin/operations/calendar');
  });
});
