/**
 * UI-6 — AVAILABILITY SEARCH.
 *
 * "I need a unit for these dates" is the one question in this product where a wrong
 * answer costs real money in both directions: report a held unit free and two guests
 * arrive for one bed; report a free unit held and the night is never sold. So most of
 * this suite is arithmetic — the half-open interval, the turnover, the boundaries, the
 * blank date — asked from the search's side rather than the calendar's.
 *
 * The rest holds four lines that must not move:
 *   · availability is derived from `stayCoversDay`, never from a second definition,
 *   · no financial field and no full guest name reaches this surface,
 *   · a booking is created by the ONE canonical form, not a copy grown here,
 *   · and no price is computed anywhere.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, within, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { AvailabilitySearch } from '@/components/operations/AvailabilitySearch';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { WorkbookViews } from '@/lib/data/views/workbook-views';
import { buildDemoWorkbook, buildDemoOps } from '@/lib/data/fixtures/workbook';
import { stayCoversDay } from '@/lib/server/analytics/kpi';
import { isoToSerial, parseIsoDay, resolveBoardDate } from '@/lib/shared/dates';
import { type ReservationRecord } from '@/lib/shared/domain';
import { NAVIGATION } from '@/lib/shared/navigation';
import { roleHasCapability, ROLES } from '@/lib/shared/roles';
import { RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS } from '@/lib/data/views/role-projections';
import { reservationFields } from '@/lib/server/api/form-fields';
import type {
  AvailabilityQuery, AvailabilitySearchView, CalendarView,
} from '@/lib/data/providers/types';
import { readSource as read, codeOf } from './support/source';

const TODAY = '2027-01-19';
const provider = new FixtureDashboardDataProvider({ now: () => new Date(`${TODAY}T10:00:00Z`) });

/** A booking record, so the arithmetic never depends on which fixture rows exist. */
const stay = (over: Partial<ReservationRecord> = {}): ReservationRecord => ({
  BookingID: 'BK-2027-9001', Platform: 'Direct', PlatformResID: '', PropertyID: 'HYD-501',
  BookingDate: null, BookingStatus: 'Confirmed', GuestName: 'Test Guest',
  Adults: 2, Children: 0,
  CheckInDate: isoToSerial('2027-01-10'), CheckOutDate: isoToSerial('2027-01-13'),
  BaseRate: 0, RoomRevenue: 0, CleaningFee: 0, ExtraGuestFee: 0, OtherCharges: 0,
  Discount: 0, Taxes: 0, PlatformFee: 0, OtherDeductions: 0, ActualPayout: 0, PayoutDate: null,
  ...over,
});

/** Views over a workbook whose reservations this suite controls outright. */
function viewsWith(reservations: ReservationRecord[]): WorkbookViews {
  const workbook = buildDemoWorkbook();
  return new WorkbookViews({ workbook: { ...workbook, reservations }, ops: buildDemoOps(TODAY) });
}

function searchWith(
  reservations: ReservationRecord[], query: AvailabilityQuery,
): AvailabilitySearchView {
  return viewsWith(reservations).availability(query);
}

/** The four demonstration units, as the fixture master states them. */
const ALL_UNITS = ['HYD-501', 'HYD-502', 'HYD-601', 'HYD-602'];
const freeIds = (view: AvailabilitySearchView) => view.available.map((u) => u.propertyId);
const heldIds = (view: AvailabilitySearchView) => view.unavailable.map((u) => u.propertyId);

const FIELDS = reservationFields(ALL_UNITS, ['Airbnb', 'Direct'], { withValues: false });

const pushed: string[] = [];
const router = {
  push: (href: string) => { pushed.push(href); },
  replace: () => {}, back: () => {}, forward: () => {}, prefetch: () => {}, refresh: () => {},
} as unknown as AppRouterInstance;

function renderUi(view: AvailabilitySearchView) {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/availability' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams('') },
          createElement(ToastProvider, null,
            createElement(AvailabilitySearch, { view, bookingFields: FIELDS }))))),
  );
}

beforeEach(() => { pushed.length = 0; cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * 1 · THE OCCUPANCY INTERVAL, FROM THE SEARCH'S SIDE
 * ================================================================== */

describe('availability · the half-open interval', () => {
  it('holds only the arrival night of a ONE-NIGHT stay', () => {
    const held = [stay({ CheckInDate: isoToSerial('2027-03-12'), CheckOutDate: isoToSerial('2027-03-13') })];

    // The night itself is gone…
    expect(freeIds(searchWith(held, { checkIn: '2027-03-12', checkOut: '2027-03-13' })))
      .not.toContain('HYD-501');
    // …and the night after it is not.
    expect(freeIds(searchWith(held, { checkIn: '2027-03-13', checkOut: '2027-03-14' })))
      .toContain('HYD-501');
    // Nor the night before.
    expect(freeIds(searchWith(held, { checkIn: '2027-03-11', checkOut: '2027-03-12' })))
      .toContain('HYD-501');
  });

  it('frees the unit ON the departure day of a MULTI-NIGHT stay', () => {
    // The brief's own example: 12 Sep → 15 Sep occupies 12, 13, 14 and frees 15.
    const held = [stay({
      BookingID: 'BK-2027-0012',
      CheckInDate: isoToSerial('2027-09-12'), CheckOutDate: isoToSerial('2027-09-15'),
    })];
    for (const night of ['2027-09-12', '2027-09-13', '2027-09-14']) {
      const view = searchWith(held, { checkIn: night, checkOut: '2027-09-15' });
      expect(freeIds(view), night).not.toContain('HYD-501');
    }
    const after = searchWith(held, { checkIn: '2027-09-15', checkOut: '2027-09-16' });
    expect(freeIds(after)).toContain('HYD-501');
    expect(after.available.find((u) => u.propertyId === 'HYD-501')!.conflicts).toEqual([]);
  });

  it('lets BACK-TO-BACK stays share the changeover date without either being free', () => {
    const held = [
      stay({ BookingID: 'BK-A', CheckInDate: isoToSerial('2027-04-10'), CheckOutDate: isoToSerial('2027-04-12') }),
      stay({ BookingID: 'BK-B', CheckInDate: isoToSerial('2027-04-12'), CheckOutDate: isoToSerial('2027-04-14') }),
    ];
    // Nothing between the 10th and the 14th is sellable…
    const across = searchWith(held, { checkIn: '2027-04-10', checkOut: '2027-04-14' });
    expect(freeIds(across)).not.toContain('HYD-501');
    const unit = heldIds(across).includes('HYD-501')
      ? across.unavailable.find((u) => u.propertyId === 'HYD-501')!
      : null;
    // …and BOTH bookings are named, as two separate runs, not merged into one.
    expect(unit!.conflicts.map((c) => c.bookingId)).toEqual(['BK-A', 'BK-B']);
    expect(unit!.conflicts[0]!.toDate).toBe('2027-04-11');
    expect(unit!.conflicts[1]!.fromDate).toBe('2027-04-12');

    // The 14th onwards is free again.
    expect(freeIds(searchWith(held, { checkIn: '2027-04-14', checkOut: '2027-04-15' })))
      .toContain('HYD-501');
  });

  it('sells the SAME-DAY turnover night to the arriving guest, once', () => {
    const held = [
      stay({ BookingID: 'BK-OUT', CheckInDate: isoToSerial('2027-05-01'), CheckOutDate: isoToSerial('2027-05-04') }),
    ];
    // The departing guest leaves on the 4th, so the 4th is sellable that same day.
    const view = searchWith(held, { checkIn: '2027-05-04', checkOut: '2027-05-05' });
    expect(freeIds(view)).toContain('HYD-501');
  });

  it('frees the unit for a CANCELLATION and a no-show', () => {
    for (const status of ['Cancelled', 'No Show']) {
      const view = searchWith(
        [stay({ BookingStatus: status, CheckInDate: isoToSerial('2027-06-01'), CheckOutDate: isoToSerial('2027-06-05') })],
        { checkIn: '2027-06-01', checkOut: '2027-06-05' },
      );
      expect(freeIds(view), status).toEqual(ALL_UNITS);
      expect(view.unavailable, status).toEqual([]);
    }
  });

  it('blocks the unit when a booking OVERLAPS the range at either end', () => {
    const held = [stay({
      BookingID: 'BK-OVER',
      CheckInDate: isoToSerial('2027-07-10'), CheckOutDate: isoToSerial('2027-07-20'),
    })];
    const cases: Array<[string, string, string]> = [
      ['starts before, ends inside', '2027-07-05', '2027-07-12'],
      ['entirely inside', '2027-07-12', '2027-07-15'],
      ['starts inside, ends after', '2027-07-18', '2027-07-25'],
      ['swallows the stay whole', '2027-07-01', '2027-07-31'],
      ['one night in the middle', '2027-07-15', '2027-07-16'],
    ];
    for (const [label, checkIn, checkOut] of cases) {
      const view = searchWith(held, { checkIn, checkOut });
      expect(freeIds(view), label).not.toContain('HYD-501');
    }
    // And the two ranges that only TOUCH it are free: the interval is half-open.
    expect(freeIds(searchWith(held, { checkIn: '2027-07-01', checkOut: '2027-07-10' })))
      .toContain('HYD-501');
    expect(freeIds(searchWith(held, { checkIn: '2027-07-20', checkOut: '2027-07-25' })))
      .toContain('HYD-501');
  });

  it('treats a blank date as absent, not as the spreadsheet epoch', () => {
    // A blank cell arrives as serial 0, not null. Without the guard an unfinished
    // booking holds every night since 1899 and nothing is ever available again.
    const view = searchWith([stay({ CheckInDate: 0, CheckOutDate: 0 })],
      { checkIn: '2027-08-01', checkOut: '2027-08-03' });
    expect(freeIds(view)).toEqual(ALL_UNITS);
  });
});

/* ================================================================== *
 * 2 · BOUNDARIES
 * ================================================================== */

describe('availability · boundaries', () => {
  it('searches across a MONTH boundary without losing the nights either side', () => {
    const held = [stay({
      BookingID: 'BK-EOM',
      CheckInDate: isoToSerial('2027-01-30'), CheckOutDate: isoToSerial('2027-02-02'),
    })];
    const view = searchWith(held, { checkIn: '2027-01-28', checkOut: '2027-02-05' });
    expect(freeIds(view)).not.toContain('HYD-501');

    const conflict = view.unavailable.find((u) => u.propertyId === 'HYD-501')!.conflicts[0]!;
    // Clipped to the range asked for, and reporting the whole stay alongside it.
    expect(conflict.fromDate).toBe('2027-01-30');
    expect(conflict.toDate).toBe('2027-02-01');
    expect(conflict.nights).toBe(3);
    expect(conflict.checkIn).toBe('2027-01-30');
    expect(conflict.checkOut).toBe('2027-02-02');

    // The nights before and after it are still sellable.
    expect(freeIds(searchWith(held, { checkIn: '2027-01-28', checkOut: '2027-01-30' })))
      .toContain('HYD-501');
    expect(freeIds(searchWith(held, { checkIn: '2027-02-02', checkOut: '2027-02-05' })))
      .toContain('HYD-501');
  });

  it('searches across a YEAR boundary — including into a leap February', () => {
    const held = [stay({
      BookingID: 'BK-NYE',
      CheckInDate: isoToSerial('2027-12-30'), CheckOutDate: isoToSerial('2028-01-02'),
    })];
    const view = searchWith(held, { checkIn: '2027-12-28', checkOut: '2028-01-04' });
    expect(view.nights).toBe(7);
    expect(freeIds(view)).not.toContain('HYD-501');
    expect(view.unavailable.find((u) => u.propertyId === 'HYD-501')!.conflicts[0]!.toDate)
      .toBe('2028-01-01');

    // 29 February exists in 2028 and the arithmetic must not skip it.
    const leap = searchWith([], { checkIn: '2028-02-27', checkOut: '2028-03-01' });
    expect(leap.nights).toBe(3);
    expect(freeIds(leap)).toEqual(ALL_UNITS);
  });

  it('agrees, night for night, with the calendar over the same month', () => {
    /*
     * The two surfaces answer the same question from opposite directions. If they ever
     * disagree, one of them is telling somebody a unit is free when it is not — so the
     * whole of January is compared cell against search, for every unit.
     */
    const reservations = buildDemoWorkbook().reservations;
    const views = viewsWith(reservations);
    const calendar: CalendarView = views.calendar({ month: '2027-01' });

    for (const unit of calendar.units) {
      for (const cell of unit.cells) {
        const night = views.availability({
          checkIn: cell.date,
          checkOut: calendar.days[calendar.days.indexOf(cell.date) + 1] ?? '2027-02-01',
          propertyId: unit.propertyId,
        });
        const searchSaysFree = night.available.some((u) => u.propertyId === unit.propertyId);
        expect(searchSaysFree, `${unit.propertyId} ${cell.date}`)
          .toBe(cell.state === 'available');
      }
    }
  });

  it('derives occupancy from the SHARED helper, never from a second definition', () => {
    const view = viewsWith(buildDemoWorkbook().reservations);
    const workbook = buildDemoWorkbook();
    const night = '2027-01-14';
    const serial = isoToSerial(night);
    const result = view.availability({ checkIn: night, checkOut: '2027-01-15' });

    for (const id of ALL_UNITS) {
      const engineSaysHeld = workbook.reservations
        .some((b) => b.PropertyID === id && stayCoversDay(b, serial));
      expect(result.available.some((u) => u.propertyId === id), `${id} ${night}`)
        .toBe(!engineSaysHeld);
    }

    // And no copy of the interval was written into the view or the component.
    const engine = codeOf(read('lib/data/views/workbook-views.ts'));
    const occurrences = engine.match(/CheckInDate\s*<=|<=\s*day\s*&&/g) ?? [];
    expect(occurrences).toHaveLength(0);
    expect(codeOf(read('components/operations/AvailabilitySearch.tsx')))
      .not.toMatch(/CheckInDate|CheckOutDate|isoToSerial|spansDay/);
  });
});

/* ================================================================== *
 * 3 · WHAT WAS ASKED FOR
 * ================================================================== */

describe('availability · the range asked for', () => {
  it('refuses a MALFORMED date instead of quietly searching a different one', () => {
    for (const bad of ['12 Sep', '2027-13-01', '2027-02-31', 'tomorrow', '2027-1-1', '../etc']) {
      const view = searchWith([], { checkIn: bad, checkOut: '2027-03-05' });
      expect(view.searched, bad).toBe(false);
      expect(view.problems.map((p) => p.field), bad).toContain('checkIn');
      expect(view.available, bad).toEqual([]);
      // What was typed comes back, so it can be corrected rather than replaced.
      expect(view.asked.checkIn, bad).toBe(bad);
    }
    // The canonical parser is the one the Today board already uses.
    expect(parseIsoDay('2027-02-31')).toBeNull();
    expect(parseIsoDay('2027-02-28')).toBe('2027-02-28');
    expect(resolveBoardDate('2027-02-31', TODAY)).toBe(TODAY);
  });

  it('refuses a CHECK-OUT that is not after the check-in', () => {
    for (const [checkIn, checkOut] of [
      ['2027-03-10', '2027-03-10'],   // nought nights is not a stay
      ['2027-03-10', '2027-03-09'],   // backwards
      ['2027-03-10', '2026-03-10'],   // backwards by a year
    ]) {
      const view = searchWith([], { checkIn, checkOut });
      expect(view.searched, `${checkIn}..${checkOut}`).toBe(false);
      expect(view.problems.some((p) => p.field === 'checkOut')).toBe(true);
      expect(view.problems[0]!.message).toMatch(/after check-in/i);
      expect(view.nights).toBe(0);
    }
  });

  it('refuses an unbounded range rather than walking a thousand years of nights', () => {
    const view = searchWith([], { checkIn: '2027-01-01', checkOut: '2999-12-31' });
    expect(view.searched).toBe(false);
    expect(view.problems[0]!.message).toMatch(new RegExp(`${view.maxNights} nights or fewer`));
    // The bound is inclusive, and one night inside it still runs.
    expect(searchWith([], { checkIn: '2027-01-01', checkOut: '2027-03-32'.replace('32', '31') }).searched)
      .toBe(true);
  });

  it('reaches the screen through the provider, wrapped like every other read', async () => {
    const envelope = await provider.getAvailability({
      checkIn: '2027-03-01', checkOut: '2027-03-04',
    });
    expect(envelope.data.searched).toBe(true);
    expect(envelope.data.nights).toBe(3);
    expect(envelope.meta).toBeTruthy();

    // Every provider offers it, so no screen depends on which source is behind it.
    for (const file of [
      'lib/data/providers/fixture-provider.ts',
      'lib/data/providers/sheets-provider.ts',
      'lib/data/providers/demo-grid-provider.ts',
    ]) {
      expect(codeOf(read(file)), file).toContain('getAvailability');
    }
  });

  it('says nothing at all until it is asked', () => {
    const view = searchWith([], {});
    expect(view.searched).toBe(false);
    expect(view.problems).toEqual([]);
    expect(view.available).toEqual([]);
    expect(view.unavailable).toEqual([]);
    // And it offers tonight, for one night — a real range, from the SOURCE's own day.
    expect(view.defaultCheckIn).toBe(TODAY);
    expect(view.defaultCheckOut).toBe('2027-01-20');
    expect(view.operationalDate).toBe(TODAY);
  });
});

/* ================================================================== *
 * 4 · NARROWING
 * ================================================================== */

describe('availability · property and capacity', () => {
  it('searches ALL PROPERTIES by default', () => {
    const view = searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03' });
    expect(freeIds(view)).toEqual(ALL_UNITS);
    expect(view.propertyId).toBeNull();
    // The control still lists every unit by its human name, whatever is selected.
    expect(view.properties.map((p) => p.id)).toEqual(ALL_UNITS);
    expect(view.properties[0]!.name).toBe('5th Floor — 2 BHK');
  });

  it('narrows to ONE SELECTED UNIT without changing the answer for it', () => {
    const held = [stay({
      PropertyID: 'HYD-502',
      CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-03'),
    })];
    const all = searchWith(held, { checkIn: '2027-03-01', checkOut: '2027-03-03' });
    const one = searchWith(held, { checkIn: '2027-03-01', checkOut: '2027-03-03', propertyId: 'HYD-502' });

    expect(freeIds(all)).toEqual(['HYD-501', 'HYD-601', 'HYD-602']);
    expect(one.available).toEqual([]);
    expect(heldIds(one)).toEqual(['HYD-502']);
    // Filtering changed WHICH units are reported, never whether one is free.
    expect(one.unavailable[0]!.conflicts.map((c) => c.bookingId))
      .toEqual(all.unavailable.find((u) => u.propertyId === 'HYD-502')!.conflicts.map((c) => c.bookingId));
  });

  it('filters on CAPACITY with the same comparison the create form validates', () => {
    // The fixture master: the 2 BHKs sleep 6, the 1 BHKs sleep 3. Nothing invented.
    const four = searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03', guests: '4' });
    expect(freeIds(four)).toEqual(['HYD-501', 'HYD-601']);
    expect(heldIds(four)).toEqual(['HYD-502', 'HYD-602']);
    expect(four.unavailable[0]!.blocker).toBe('capacity');
    expect(four.unavailable[0]!.conflicts).toEqual([]);

    // Exactly at the maximum still fits — `>` is the rule, not `>=`.
    expect(freeIds(searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03', guests: '3' })))
      .toEqual(ALL_UNITS);
    // Above every unit's maximum leaves nothing.
    expect(freeIds(searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03', guests: '7' })))
      .toEqual([]);
    // Blank means "any size".
    expect(searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03', guests: '' }).guests)
      .toBeNull();

    // The comparison is the pipeline's own: total headcount against MaxGuests.
    expect(codeOf(read('lib/server/api/mutation-services.ts')))
      .toContain('guests > unit.MaxGuests');
  });

  it('rejects a guest count that is not a whole number of people', () => {
    for (const bad of ['0', '-2', '2.5', 'four', '999']) {
      const view = searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-03', guests: bad });
      expect(view.searched, bad).toBe(false);
      expect(view.problems.map((p) => p.field), bad).toContain('guests');
    }
  });

  it('reports an EMPTY RESULT as an answer, with the units that hold the dates', () => {
    const held = ALL_UNITS.map((id, i) => stay({
      BookingID: `BK-FULL-${i}`, PropertyID: id, GuestName: 'Priya Sharma',
      CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-05'),
    }));
    const view = searchWith(held, { checkIn: '2027-03-02', checkOut: '2027-03-04' });

    expect(view.searched).toBe(true);
    expect(view.available).toEqual([]);
    expect(heldIds(view)).toEqual(ALL_UNITS);
    expect(view.unavailable.every((u) => u.blocker === 'booked')).toBe(true);
    expect(view.unavailable[0]!.conflicts[0]!.nights).toBe(2);
  });

  it('never lets a platform narrow the register on an availability question', () => {
    /*
     * A booking holds the unit whoever sold it. Accepting a platform filter here would
     * report a unit free because the booking holding it was hidden from the query — the
     * one lie this screen must not tell.
     */
    const code = codeOf(read('lib/data/views/workbook-views.ts'));
    const method = code.slice(code.indexOf('availability(query'), code.indexOf('revenue(filters'));
    // The platform is REPORTED on a conflict, exactly as the register reports it. What
    // must not exist is a platform anywhere near the filtering.
    expect(method).toContain('platform: booking.Platform');
    expect(method).not.toMatch(/\.platform(?!\s*\})|query\.platform|filters\.platform/);
    expect(method).not.toMatch(/Platform\s*===|=== *b\.Platform|filter\([^)]*Platform/);
    /* The page knows the platform LIST — the create form needs it — and never hands a
       platform to the search. Those are different things and only one is dangerous. */
    const page = read('app/admin/operations/availability/page.tsx');
    expect(page).toContain('getPlatforms()');
    expect(page).not.toMatch(/params\.platform|platform: /);
  });
});

/* ================================================================== *
 * 5 · WHAT THE SCREEN MAY SAY
 * ================================================================== */

describe('availability · disclosure', () => {
  it('carries NO FINANCIAL FIELD anywhere on the view or the component', () => {
    const view = searchWith(
      [stay({ BaseRate: 9999, RoomRevenue: 9999, ActualPayout: 9999, CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-05') })],
      { checkIn: '2027-03-01', checkOut: '2027-03-05' },
    );
    const serialised = JSON.stringify(view);
    for (const field of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(serialised, field).not.toContain(field);
    }
    for (const field of [
      'BaseRate', 'RoomRevenue', 'CleaningFee', 'ExtraGuestFee', 'Discount', 'Taxes',
      'PlatformFee', 'OtherDeductions', 'GrossBookingValue', 'ExpectedPayout',
      'PayoutStatus', 'PayoutVariance', 'ActualPayout', 'PayoutDate',
    ]) {
      expect(serialised, field).not.toContain(field);
    }
    expect(serialised).not.toContain('9999');

    const client = codeOf(read('components/operations/AvailabilitySearch.tsx'));
    expect(client).not.toMatch(
      /payout|revenue|grossValue|baseRate|cleaningFee|₹|price|tariff|amount/i);
  });

  it('computes NO PRICE — availability is availability', () => {
    const code = codeOf(read('lib/data/views/workbook-views.ts'));
    const method = code.slice(code.indexOf('availability(query'), code.indexOf('revenue(filters'));
    expect(method).not.toMatch(/nights\s*\*|\*\s*nights|rate|price|amount|commission|tax/i);
    expect(codeOf(read('app/admin/operations/availability/page.tsx')))
      .not.toMatch(/price|rate|payout|revenue/i);
  });

  it('shows the MINIMISED guest name and never a full one', () => {
    const view = searchWith(
      [stay({ GuestName: 'Priyanka Venkataraman', CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-05') })],
      { checkIn: '2027-03-01', checkOut: '2027-03-05' },
    );
    const conflict = view.unavailable[0]!.conflicts[0]!;
    expect(conflict.guestDisplayName).toBe('Priyanka V.');
    expect(JSON.stringify(view)).not.toContain('Venkataraman');

    const client = codeOf(read('components/operations/AvailabilitySearch.tsx'));
    expect(client).not.toMatch(/guestName|fullName|email|phone|contact/i);
  });

  it('is guarded by the same capability as the register it searches', () => {
    const src = read('app/admin/operations/availability/page.tsx');
    expect(src).toContain('capability="reservations.read"');

    // OPERATIONS works bookings, so it searches availability.
    expect(roleHasCapability('OPERATIONS', 'reservations.read')).toBe(true);
    // An INVESTOR holds it nowhere near, and gains nothing from this screen existing.
    expect(roleHasCapability('INVESTOR', 'reservations.read')).toBe(false);
    for (const role of ROLES) {
      if (role === 'INVESTOR') continue;
      expect(roleHasCapability(role, 'reservations.read'), role).toBe(true);
    }
  });

  it('appears once in the menu, under the capability it is guarded by', () => {
    const items = NAVIGATION.flatMap((s) => s.items);
    const entries = items.filter((i) => i.href === '/admin/operations/availability');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.label).toBe('Find a unit');
    expect(entries[0]!.capability).toBe('reservations.read');
  });

  it('carries a standing master flag as a CAUTION, never as a decision', () => {
    /*
     * `PropertyStatus` is a manual, UNDATED flag (UI-5, DECISION 1). Letting it remove a
     * unit from a search for March would be an undated value speaking for a date — and
     * silently removing inventory nobody can see was removed.
     */
    const workbook = buildDemoWorkbook();
    const properties = workbook.properties.map((p) => (
      p.PropertyID === 'HYD-601' ? { ...p, PropertyStatus: 'Blocked' } : p
    ));
    const views = new WorkbookViews({ workbook: { ...workbook, properties, reservations: [] }, ops: buildDemoOps(TODAY) });
    const view = views.availability({ checkIn: '2027-03-01', checkOut: '2027-03-03' });

    const unit = view.available.find((u) => u.propertyId === 'HYD-601')!;
    expect(unit.available).toBe(true);
    expect(unit.outOfService).toBe(true);
    expect(unit.propertyStatus).toBe('Blocked');
    // But it sorts behind the units that need no second thought.
    expect(freeIds(view).at(-1)).toBe('HYD-601');
  });
});

/* ================================================================== *
 * 6 · THE SCREEN
 * ================================================================== */

describe('availability · the search surface', () => {
  it('labels every control, and marks the field the server rejected', async () => {
    const view = searchWith([], { checkIn: '2027-02-31', checkOut: '2027-03-05', guests: '2' });
    renderUi(view);

    for (const label of ['Check-in', 'Check-out', 'Property', 'Guests']) {
      expect(screen.getByLabelText(new RegExp(label, 'i')), label).toBeTruthy();
    }
    const checkIn = screen.getByLabelText(/Check-in/i);
    expect(checkIn.getAttribute('aria-invalid')).toBe('true');
    expect(checkIn.getAttribute('aria-describedby')).toContain('avail-checkin-error');
    expect(screen.getByRole('alert').textContent).toMatch(/not a real calendar day/i);
    // The date the reader typed is still on screen to be corrected.
    expect(view.asked.checkIn).toBe('2027-02-31');

    // The field that was fine is not marked.
    expect(screen.getByLabelText(/Guests/i).getAttribute('aria-invalid')).toBeNull();
  });

  it('puts the whole search in the URL, so a search is a link', async () => {
    const view = searchWith([], {});
    renderUi(view);

    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /Search availability/i }));

    expect(pushed).toHaveLength(1);
    const url = new URL(pushed[0]!, 'https://example.test');
    expect(url.pathname).toBe('/admin/operations/availability');
    expect(url.searchParams.get('checkin')).toBe(TODAY);
    expect(url.searchParams.get('checkout')).toBe('2027-01-20');
  });

  it('states availability in WORDS, so colour is never carrying the answer', () => {
    const held = [stay({
      BookingID: 'BK-2027-7788', PropertyID: 'HYD-502', GuestName: 'Rahul Menon',
      CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-05'),
    })];
    const view = searchWith(held, { checkIn: '2027-03-01', checkOut: '2027-03-05' });
    const { container } = renderUi(view);

    const free = container.querySelector('.sv-availcard--free')!;
    expect(within(free as HTMLElement).getByText('Available')).toBeTruthy();

    const taken = container.querySelector('.sv-availcard--held')!;
    expect(within(taken as HTMLElement).getByText('Booked')).toBeTruthy();
    expect(taken.textContent).toContain('BK-2027-7788');
    expect(taken.textContent).toContain('Rahul M.');
    expect(taken.textContent).not.toContain('Menon');

    // And the whole answer is announced, not just drawn.
    const status = container.querySelector('[role="status"]')!;
    expect(status.getAttribute('aria-live')).toBe('polite');
    expect(status.textContent).toMatch(/3 of 4 units free for 4 nights/);
  });

  it('opens the CANONICAL booking form for a chosen unit, prefilled and without money', async () => {
    const view = searchWith([], { checkIn: '2027-03-01', checkOut: '2027-03-04', guests: '2' });
    const { container } = renderUi(view);

    const user = userEvent.setup();
    const first = container.querySelector('.sv-availcard--free')!;
    await user.click(within(first as HTMLElement).getByRole('button', { name: 'Select' }));

    const drawer = document.querySelector('.sv-drawer, [role="dialog"]')! as HTMLElement;
    expect(drawer.textContent).toContain('Place a booking in 5th Floor — 2 BHK');

    // The search's answers are already in the form…
    expect((within(drawer).getByLabelText(/Check-in/i) as HTMLInputElement).value).toBe('2027-03-01');
    expect((within(drawer).getByLabelText(/Check-out/i) as HTMLInputElement).value).toBe('2027-03-04');
    expect((within(drawer).getByLabelText(/^Property/i) as HTMLSelectElement).value).toBe('HYD-501');
    expect((within(drawer).getByLabelText(/Adults/i) as HTMLInputElement).value).toBe('2');

    // …and no money field is in it, because none was ever offered to this surface.
    for (const money of [/base rate/i, /room revenue/i, /cleaning fee/i, /discount/i]) {
      expect(within(drawer).queryByLabelText(money), String(money)).toBeNull();
    }

    // The row the open form belongs to says so.
    expect(container.querySelector('.sv-availcard--selected')).toBe(first);
    expect(first.getAttribute('aria-current')).toBe('true');
  });

  it('creates bookings through the ONE canonical form, never a copy grown here', () => {
    const client = codeOf(read('components/operations/AvailabilitySearch.tsx'));
    // The shared create component, the shared endpoint, and specs built on the SERVER.
    expect(client).toContain('NewRecordButton');
    expect(client).toContain("endpoint=\"/api/reservations\"");
    expect(client).toContain('bookingFields');
    // No form element of its own, and no field list assembled in the browser.
    expect(client).not.toMatch(/<MutationForm|reservationFields\(|guestName'|bookingStatus'/);

    const page = read('app/admin/operations/availability/page.tsx');
    expect(page).toContain("reservationFields(propertyIds, platforms, { withValues: false })");

    // Exactly two surfaces build reservation create fields: Bookings, and this one.
    const callers = ['app/admin/operations/reservations/page.tsx', 'app/admin/operations/availability/page.tsx'];
    for (const file of callers) {
      expect(codeOf(read(file)), file).toContain('reservationFields(');
    }
  });
});

/* ================================================================== *
 * 7 · THE TWO SURFACES, JOINED
 * ================================================================== */

describe('availability · calendar integration', () => {
  it('CALENDAR → SEARCH carries the selected day as a real one-night range', async () => {
    const calendar = viewsWith([]).calendar({ month: '2027-01', date: '2027-01-22' });
    expect(calendar.selectedDate).toBe('2027-01-22');
    // The departure day of a one-night stay, computed once, on the server.
    expect(calendar.selectedNextDate).toBe('2027-01-23');

    const client = codeOf(read('components/operations/AvailabilityCalendar.tsx'));
    expect(client).toContain('/admin/operations/availability');
    expect(client).toContain('checkin: view.selectedDate');
    expect(client).toContain('checkout: view.selectedNextDate');
    // The property the reader had narrowed to travels with them.
    expect(client).toContain("searchParams.get('property')");
    // And no second copy of the arithmetic appears in the browser.
    expect(client).not.toMatch(/isoToSerial|shiftIsoDay|new Date\(/);
  });

  it('SEARCH → CALENDAR returns to the same date and property', () => {
    const view = searchWith([], { checkIn: '2027-05-14', checkOut: '2027-05-17', propertyId: 'HYD-602' });
    const { container } = renderUi(view);

    const links = Array.from(container.querySelectorAll('a'))
      .map((a) => a.getAttribute('href') ?? '')
      .filter((href) => href.startsWith('/admin/operations/calendar'));
    expect(links.length).toBeGreaterThan(0);

    for (const href of links) {
      const url = new URL(href, 'https://example.test');
      expect(url.searchParams.get('month')).toBe('2027-05');
      expect(url.searchParams.get('date')).toBe('2027-05-14');
      expect(url.searchParams.get('property')).toBe('HYD-602');
    }
  });

  it('a conflicting booking opens in the SAME detail panel the register uses', () => {
    const held = [stay({
      BookingID: 'BK-2027-4242', PropertyID: 'HYD-501',
      CheckInDate: isoToSerial('2027-03-01'), CheckOutDate: isoToSerial('2027-03-05'),
    })];
    const view = searchWith(held, { checkIn: '2027-03-01', checkOut: '2027-03-05' });
    const { container } = renderUi(view);

    const ref = container.querySelector('.sv-availconflict__ref')!;
    expect(ref.getAttribute('href')).toBe('/admin/operations/reservations?booking=BK-2027-4242');
    // Everything the pixels cannot fit is in the accessible name.
    expect(ref.getAttribute('aria-label')).toMatch(/BK-2027-4242.+Confirmed.+Direct/);

    // No detail system of its own.
    expect(codeOf(read('components/operations/AvailabilitySearch.tsx')))
      .not.toMatch(/BookingDetailDrawer|getBookingDetail/);
  });

  it('is reachable from the three screens a front office already lives on', () => {
    for (const file of [
      'components/operations/BookingsWorkspace.tsx',
      'components/operations/TodayBoard.tsx',
      'components/operations/AvailabilityCalendar.tsx',
    ]) {
      expect(codeOf(read(file)), file).toContain('/admin/operations/availability');
    }
    // One search screen in the product: no other menu entry claims to be one.
    const items = NAVIGATION.flatMap((s) => s.items);
    expect(items.filter((i) => i.href.endsWith('/availability'))).toHaveLength(1);
  });
});
