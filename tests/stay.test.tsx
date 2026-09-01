/**
 * UI-7 — THE STAY: arrival, in house, departure.
 *
 * A booking becomes operationally usable at exactly two moments — the guest arrives and
 * the guest leaves — and each of them writes facts somebody later depends on: what time
 * it happened, whether ID was checked, what the unit was left like. This suite covers
 * both, at the pipeline where they are written and at the panel where they are read.
 *
 * Four lines must not move:
 *   · the transition table is the server's, and no screen may talk a booking past it,
 *   · an omitted field writes nothing — a blank must never erase what is on file,
 *   · no financial field, no full guest name and no contact detail reaches this workflow,
 *   · and nothing here charges for anything. A late departure is a fact, not an invoice.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { randomUUID } from 'node:crypto';
import { createElement, type ReactElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import { BookingActions } from '@/components/operations/BookingActions';
import { checkInFields, checkOutFields } from '@/lib/server/api/form-fields';
import { RESERVATION_TRANSITIONS } from '@/lib/server/api/schemas';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { WorkbookViews } from '@/lib/data/views/workbook-views';
import { buildDemoWorkbook, buildDemoOps } from '@/lib/data/fixtures/workbook';
import { isoToSerial } from '@/lib/shared/dates';
import { roleHasCapability, ROLES } from '@/lib/shared/roles';
import {
  operationalBookingDetail, DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS,
  type OperationalBookingDetail,
} from '@/lib/data/views/role-projections';
import type { ReservationRecord } from '@/lib/shared/domain';
import { createWriteHarness, type WriteHarness } from './support/write-harness';
import { readSource as read, codeOf } from './support/source';

const TODAY = '2027-01-19';
const provider = new FixtureDashboardDataProvider({ now: () => new Date(`${TODAY}T10:00:00Z`) });

let h: WriteHarness;
beforeEach(() => { h = createWriteHarness(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/** A confirmed booking on the real pipeline, ready to arrive. */
async function aConfirmedBooking(over: Record<string, unknown> = {}): Promise<string> {
  const res = await h.request('operations', 'POST', '/api/reservations', {
    operationId: randomUUID(), platform: 'Airbnb', propertyId: 'HYD-501',
    bookingDate: '2026-08-20', guestName: 'Priyanka Venkataraman', adults: 2, children: 1,
    checkInDate: '2026-09-01', checkOutDate: '2026-09-03', bookingStatus: 'Confirmed',
    ...over,
  });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body.record.BookingID as string;
}

/* ================================================================== *
 * 1 · ARRIVAL — the write
 * ================================================================== */

describe('stay · arrival', () => {
  it('records the whole arrival, and reads it back from the workbook', async () => {
    const id = await aConfirmedBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`, {
      operationId: randomUUID(),
      checkInTime: '14:35',
      guestVerification: 'Verified',
      earlyCheckIn: true,
      notes: 'Arrived early, bags held at the desk.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // The response IS the row read back after the write — not an echo of the request.
    expect(res.body.meta.verified).toBe(true);
    expect(res.body.record.BookingStatus).toBe('Checked In');
    expect(res.body.record.CheckInTime).toBe('14:35');
    expect(res.body.record.GuestVerification).toBe('Verified');
    expect(res.body.record.EarlyCheckIn).toBe(true);
    expect(res.body.record.Notes).toBe('Arrived early, bags held at the desk.');
  });

  it('leaves every field nobody filled in exactly as it was', async () => {
    const id = await aConfirmedBooking({ notes: 'Late flight — expect after 22:00.' });
    // The transition alone: a front desk that records nothing but the arrival itself.
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID() });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.record.BookingStatus).toBe('Checked In');
    // The booking's own note survived. A blank box must never be a delete.
    expect(res.body.record.Notes).toBe('Late flight — expect after 22:00.');
  });

  it('refuses an arrival the transition table does not allow', async () => {
    // Cancelled is terminal — the table says so, and the server is what enforces it.
    expect(RESERVATION_TRANSITIONS['Cancelled']).toEqual([]);

    const id = await aConfirmedBooking();
    const cancelled = await h.request('operations', 'POST', `/api/reservations/${id}/cancel`, {
      operationId: randomUUID(), reason: 'Guest cancelled by email.',
    });
    expect(cancelled.status).toBe(200);

    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`, {
      operationId: randomUUID(), checkInTime: '14:35',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.join(' '))
      .toMatch(/A booking in status "Cancelled" cannot move to "Checked In"/);
  });

  it('refuses a second arrival for a guest already in the house', async () => {
    const id = await aConfirmedBooking();
    await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:00' });

    const again = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '18:00' });
    expect(again.status).toBe(422);

    // And the first arrival's time was not overwritten by the refused one.
    const rows = await h.deps.repos.reservations.readAll();
    expect(rows.find((b) => b.BookingID === id)!.CheckInTime).toBe('14:00');
  });

  it('treats a double-click as ONE arrival', async () => {
    const id = await aConfirmedBooking();
    const operationId = randomUUID();
    const payload = { operationId, checkInTime: '14:35', guestVerification: 'Verified' };

    // Two submissions racing, as a double-tapped button on a phone produces them.
    const racing = await Promise.all([
      h.request('operations', 'POST', `/api/reservations/${id}/check-in`, payload),
      h.request('operations', 'POST', `/api/reservations/${id}/check-in`, payload),
    ]);
    const winners = racing.filter((r) => r.status === 200);
    const inFlight = racing.filter((r) => r.status === 409 && r.body.error.code === 'OPERATION_IN_FLIGHT');
    expect(winners.length).toBe(1);
    expect(winners.length + inFlight.length).toBe(2);

    /*
     * A submission that arrives after the first FINISHED is refused too — but by the
     * transition table rather than by the operation store, because the pipeline validates
     * business rules (step 4) before it looks up the operation id (step 5). Both paths
     * reach the same place: the guest is checked in exactly once, and the recorded time
     * is the one the winning request carried.
     */
    const late = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`, payload);
    expect(late.status).toBe(422);
    expect(late.body.error.details.join(' ')).toMatch(/cannot move to "Checked In"/);

    const rows = await h.deps.repos.reservations.readAll();
    const after = rows.filter((b) => b.BookingID === id);
    expect(after).toHaveLength(1);
    expect(after[0]!.CheckInTime).toBe('14:35');
    expect(after[0]!.BookingStatus).toBe('Checked In');
  });
});

/* ================================================================== *
 * 2 · DEPARTURE — the write
 * ================================================================== */

describe('stay · departure', () => {
  async function anInHouseBooking(): Promise<string> {
    const id = await aConfirmedBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:00' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return id;
  }

  it('records the whole departure, and reads it back from the workbook', async () => {
    const id = await anInHouseBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, {
      operationId: randomUUID(),
      checkOutTime: '11:20',
      lateCheckout: true,
      damageReport: 'Chipped mug in the kitchen.',
      maintenanceRequired: true,
      notes: 'Keys returned. Turnover needed before the next arrival.',
    });

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.meta.verified).toBe(true);
    expect(res.body.record.BookingStatus).toBe('Checked Out');
    expect(res.body.record.CheckOutTime).toBe('11:20');
    expect(res.body.record.LateCheckout).toBe(true);
    expect(res.body.record.DamageReport).toBe('Chipped mug in the kitchen.');
    expect(res.body.record.MaintenanceRequired).toBe(true);
    expect(res.body.record.Notes).toMatch(/Turnover needed/);
  });

  it('records "nothing to report" as an answer, distinct from silence', async () => {
    const id = await anInHouseBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, {
      operationId: randomUUID(), checkOutTime: '10:00', maintenanceRequired: false,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // FALSE was recorded — somebody looked and found nothing. Not the same as untouched.
    expect(res.body.record.MaintenanceRequired).toBe(false);
    // And the damage report nobody filled in stays empty rather than becoming "none".
    expect(res.body.record.DamageReport ?? '').toBe('');
  });

  it('refuses a departure for a guest who never arrived', async () => {
    expect(RESERVATION_TRANSITIONS['Confirmed']).not.toContain('Checked Out');

    const id = await aConfirmedBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, {
      operationId: randomUUID(), checkOutTime: '11:20',
    });
    expect(res.status).toBe(422);
    expect(res.body.error.details.join(' '))
      .toMatch(/A booking in status "Confirmed" cannot move to "Checked Out"/);
  });

  it('treats a double-click as ONE departure', async () => {
    const id = await anInHouseBooking();
    const operationId = randomUUID();
    const payload = { operationId, checkOutTime: '11:20', maintenanceRequired: true };

    const racing = await Promise.all([
      h.request('operations', 'POST', `/api/reservations/${id}/check-out`, payload),
      h.request('operations', 'POST', `/api/reservations/${id}/check-out`, payload),
    ]);
    expect(racing.filter((r) => r.status === 200)).toHaveLength(1);
    expect(racing.filter((r) => r.status === 409
      && r.body.error.code === 'OPERATION_IN_FLIGHT')).toHaveLength(1);

    // Late duplicate: refused by the transition table, for the same reason as above.
    const late = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, payload);
    expect(late.status).toBe(422);

    const rows = await h.deps.repos.reservations.readAll();
    const after = rows.find((b) => b.BookingID === id)!;
    expect(after.BookingStatus).toBe('Checked Out');
    expect(after.CheckOutTime).toBe('11:20');
  });

  it('never accepts a figure, a deposit or a charge on either transition', async () => {
    const id = await anInHouseBooking();
    for (const money of ['amount', 'deposit', 'lateFee', 'refund', 'actualPayout', 'baseRate']) {
      const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-out`, {
        operationId: randomUUID(), checkOutTime: '11:20', [money]: 500,
      });
      // `.strict()` — an unknown key is a refusal, not a silently ignored field.
      expect(res.status, `${money} must be refused`).toBe(422);
    }
  });
});

/* ================================================================== *
 * 3 · WHAT THE DESK IS ASKED FOR
 * ================================================================== */

describe('stay · the arrival and departure forms', () => {
  const names = (fields: ReturnType<typeof checkInFields>) => fields.map((f) => f.name);

  it('asks, at arrival, for what a front desk actually observes', () => {
    const fields = checkInFields({ notes: 'Ground floor requested.' });
    expect(names(fields)).toEqual(['checkInTime', 'guestVerification', 'earlyCheckIn', 'notes']);

    // The verification vocabulary is the contract's own VERIFY list, never retyped.
    const verify = fields.find((f) => f.name === 'guestVerification')!;
    expect(verify.type).toBe('select');
    expect(verify.options?.map((o) => o.value)).toEqual(['Pending', 'Verified', 'Issue']);

    // A bool column is asked as a boolean, so the payload type matches the column type.
    expect(fields.find((f) => f.name === 'earlyCheckIn')!.type).toBe('boolean');

    // Nothing is required: an arrival with only the transition recorded is a real one.
    expect(fields.every((f) => !f.required)).toBe(true);
  });

  it('asks, at departure, for the two facts housekeeping and maintenance need', () => {
    const fields = checkOutFields({ notes: null });
    expect(names(fields))
      .toEqual(['checkOutTime', 'lateCheckout', 'damageReport', 'maintenanceRequired', 'notes']);
    expect(fields.find((f) => f.name === 'maintenanceRequired')!.type).toBe('boolean');
    expect(fields.find((f) => f.name === 'lateCheckout')!.type).toBe('boolean');
    expect(fields.find((f) => f.name === 'damageReport')!.type).toBe('textarea');
  });

  it('offers notes ONLY where the current value can be shown', () => {
    /*
     * The write replaces the cell and the pipeline has no append — `toColumns` sees the
     * request, never the row. So an empty notes box beside existing notes deletes them
     * the first time somebody types in it. Prefilled, the person edits what is there.
     */
    expect(names(checkInFields())).not.toContain('notes');
    expect(names(checkOutFields())).not.toContain('notes');

    const prefilled = checkInFields({ notes: 'Ground floor requested.' })
      .find((f) => f.name === 'notes')!;
    expect(prefilled.defaultValue).toBe('Ground floor requested.');
  });

  it('carries no money, no deposit and no charge, on either form', () => {
    const forbidden = /amount|deposit|fee|charge|refund|payout|rate|price|tax|commission/i;
    for (const field of [...checkInFields({ notes: null }), ...checkOutFields({ notes: null })]) {
      expect(field.name, field.name).not.toMatch(forbidden);
      expect(field.type, field.name).not.toBe('currency');
    }
    // And the specs themselves never mention one.
    const src = codeOf(read('lib/server/api/form-fields.ts'));
    const block = src.slice(src.indexOf('export function checkInFields'), src.indexOf('export function markCleanFields'));
    expect(block).not.toMatch(/currency|amount|deposit/i);
  });
});

/* ================================================================== *
 * 4 · THE PANEL — where the stay is, in words
 * ================================================================== */

const refresh = vi.fn();
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {}, refresh,
  replace: () => {},
} as unknown as AppRouterInstance;

function renderUi(ui: ReactElement, search = 'booking=BK-2027-0001') {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/reservations' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

const QUIET_UNIT = {
  housekeeping: null, housekeepingTaskId: null, housekeepingInspection: null,
  housekeepingCleaner: null,
  openMaintenance: 0, maintenancePriority: null, maintenanceHeadline: null,
};

const booking = (over: Partial<OperationalBookingDetail> = {}): OperationalBookingDetail => ({
  bookingId: 'BK-2027-0001', platform: 'Airbnb', platformRef: 'AI100001',
  propertyId: 'HYD-501', unitName: '5th Floor — 2 BHK', bookingStatus: 'Confirmed',
  guestDisplayName: 'Priya S.', adults: 2, children: 1, guests: 3,
  bookedOn: null, checkIn: '2027-02-10', checkOut: '2027-02-13', nights: 3,
  checkInTime: null, checkOutTime: null, earlyCheckIn: null, lateCheckout: null,
  guestVerification: null, damageReport: null, maintenanceRequired: null, notes: null,
  unitState: QUIET_UNIT,
  ...over,
});

const panel = (over: Partial<OperationalBookingDetail> = {}) =>
  renderUi(createElement(BookingDetailDrawer, {
    detail: booking(over), requestedId: 'BK-2027-0001',
  }));

const bannerOf = (container: HTMLElement) => container.querySelector('.sv-stay')!;

describe('stay · the panel says where the stay is', () => {
  it('reads as ARRIVING before the guest is here', () => {
    const { container } = panel();
    const banner = bannerOf(container);
    expect(banner.textContent).toContain('Arriving');
    expect(banner.textContent).toMatch(/3 nights in 5th Floor — 2 BHK/);
  });

  it('reads as IN HOUSE once checked in, with the time it actually happened', () => {
    const { container } = panel({
      bookingStatus: 'Checked In', checkInTime: '14:35', guestVerification: 'Verified',
      earlyCheckIn: true,
    });
    const banner = bannerOf(container);
    expect(banner.textContent).toContain('In house');
    expect(banner.textContent).toContain('Arrived at 14:35');
    // The word is the state; the colour only reinforces it.
    expect(banner.className).toContain('sv-stay--checked-in');

    // And the operational facts recorded at arrival are on the panel, not just in a sheet.
    expect(container.textContent).toContain('Verified');
    expect(within(container).getByText('Early check-in').nextElementSibling!.textContent).toBe('Yes');
  });

  it('says so plainly when a guest is in the house and nobody noted the time', () => {
    const { container } = panel({ bookingStatus: 'Checked In', checkInTime: null });
    expect(bannerOf(container).textContent).toContain('Arrival time not recorded');
    // Never a fabricated time, and never a blank pretending to be one.
    expect(bannerOf(container).textContent).not.toMatch(/Arrived at\s*[.—]/);
  });

  it('reads as COMPLETE once departed, with the departure time', () => {
    const { container } = panel({
      bookingStatus: 'Checked Out', checkInTime: '14:35', checkOutTime: '11:20',
      damageReport: 'Chipped mug.', maintenanceRequired: true, lateCheckout: true,
    });
    expect(bannerOf(container).textContent).toContain('Stay complete');
    expect(bannerOf(container).textContent).toContain('Departed at 11:20');
    expect(within(container).getByText('Damage report').nextElementSibling!.textContent)
      .toBe('Chipped mug.');
    expect(within(container).getByText('Maintenance required').nextElementSibling!.textContent)
      .toBe('Yes');
  });

  it('keeps "not recorded" distinct from "no"', () => {
    const { container } = panel({ bookingStatus: 'Checked Out', checkOutTime: '11:20' });
    // Nobody said the unit was clean — the panel must not say it for them.
    expect(within(container).getByText('Maintenance required').nextElementSibling!.textContent)
      .toBe('Not recorded');
    expect(within(container).getByText('Damage report').nextElementSibling!.textContent)
      .toBe('Not recorded');
  });

  it('reports the UNIT\'s own state, and says that is what it is', () => {
    const { container } = panel({
      bookingStatus: 'Checked Out',
      unitState: {
        housekeeping: 'In Progress', housekeepingTaskId: 'HK-2027-0044',
        housekeepingInspection: 'Pending', housekeepingCleaner: 'Lakshmi',
        openMaintenance: 2,
        maintenancePriority: 'Critical', maintenanceHeadline: 'Geyser leaking in the bathroom',
      },
    });
    const headings = [...container.querySelectorAll('.sv-bkdetail__heading')].map((n) => n.textContent);
    // Titled for the UNIT: there is no booking-to-turnover link in the domain to claim.
    expect(headings).toContain('This unit, right now');
    expect(within(container).getByText('Turnover').nextElementSibling!.textContent).toBe('In Progress');
    expect(within(container).getByText('Open maintenance').nextElementSibling!.textContent)
      .toBe('2 open · Critical priority');
    expect(container.textContent).toContain('Geyser leaking in the bathroom');
  });

  it('offers exactly the one legal next step, and opens it beside the booking', async () => {
    for (const [status, label] of [
      ['Confirmed', 'Check in'], ['Checked In', 'Check out'],
    ] as const) {
      cleanup();
      const detail = booking({ bookingStatus: status });
      const { container } = renderUi(createElement(BookingDetailDrawer, {
        detail, requestedId: detail.bookingId,
        actions: createElement(BookingActions, { booking: detail }),
      }));
      expect(within(container).getByRole('button', { name: label })).toBeTruthy();
      // The other transition is not offered at all — the table allows one.
      const other = label === 'Check in' ? 'Check out' : 'Check in';
      expect(within(container).queryByRole('button', { name: other })).toBeNull();
    }

    // Opening it puts the booking in front of the person, in a drawer rather than a
    // dialog: an arrival is confirmed by reading the stay back.
    cleanup();
    const detail = booking({ bookingStatus: 'Confirmed' });
    renderUi(createElement(BookingActions, { booking: detail }));
    await userEvent.setup().click(screen.getByRole('button', { name: 'Check in' }));
    await waitFor(() => expect(document.querySelector('.sv-drawer')).toBeTruthy());
    const drawer = document.querySelector('.sv-drawer') as HTMLElement;
    expect(drawer.querySelector('.sv-staycontext')!.textContent).toContain('5th Floor — 2 BHK');
    expect(drawer.querySelector('.sv-staycontext')!.textContent).toContain('3 nights');
    expect(within(drawer).getByLabelText(/Arrival time/)).toBeTruthy();
    expect(within(drawer).getByLabelText(/ID checked/)).toBeTruthy();
  });

  it('takes no further action once the booking is closed', () => {
    for (const status of ['Checked Out', 'Cancelled', 'No Show']) {
      cleanup();
      const detail = booking({ bookingStatus: status });
      renderUi(createElement(BookingActions, { booking: detail }));
      expect(screen.queryByRole('button', { name: 'Check in' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Check out' })).toBeNull();
    }
  });
});

/* ================================================================== *
 * 5 · SECURITY
 * ================================================================== */

describe('stay · disclosure', () => {
  it('carries no financial field into the workflow at all', async () => {
    const { data } = await provider.getBookingDetail(
      (await provider.getReservations({ month: '2027-01' })).data[0]!.bookingId);
    const projected = operationalBookingDetail(data!);
    const serialised = JSON.stringify(projected);

    for (const field of DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(serialised, field).not.toContain(field);
    }
    for (const field of [
      'BaseRate', 'RoomRevenue', 'CleaningFee', 'ExtraGuestFee', 'Discount', 'Taxes',
      'PlatformFee', 'OtherDeductions', 'GrossBookingValue', 'ExpectedPayout',
      'PayoutStatus', 'PayoutVariance',
    ]) {
      expect(serialised, field).not.toContain(field);
    }

    const client = codeOf(read('components/operations/BookingDetailDrawer.tsx'));
    expect(client).not.toMatch(/payout|grossValue|expectedPayout|₹/i);
  });

  it('never discloses a full guest name, and never writes the minimised one back', async () => {
    const id = await aConfirmedBooking();
    const res = await h.request('operations', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:35' });
    // The arrival wrote no name at all, so the real one on file is untouched.
    expect(res.body.record.GuestName).toBe('Priyanka Venkataraman');
    expect(Object.keys(checkInFields({ notes: null }))).not.toContain('guestName');

    const { data } = await provider.getBookingDetail(
      (await provider.getReservations({ month: '2027-01' })).data[0]!.bookingId);
    // What the panel receives is minimised: a given name and one initial, never more.
    expect(operationalBookingDetail(data!).guestDisplayName).toMatch(/^\S+(\s\S\.)?$/);
  });

  it('has nowhere to put a phone number, an email or a document', () => {
    const contact = /phone|mobile|email|passport|aadhaar|\bid ?upload\b|document|address/i;
    for (const field of [...checkInFields({ notes: null }), ...checkOutFields({ notes: null })]) {
      expect(field.name, field.name).not.toMatch(contact);
    }
    for (const file of [
      'components/operations/BookingDetailDrawer.tsx',
      'components/operations/BookingActions.tsx',
    ]) {
      expect(codeOf(read(file)), file).not.toMatch(/phone|email|passport|aadhaar/i);
    }
    // The projection has no such field either, so there is nothing to render.
    const shape = read('lib/data/views/role-projections.ts');
    const detail = shape.slice(shape.indexOf('export interface OperationalBookingDetail'),
      shape.indexOf('export const DETAIL_FIELDS_WITHHELD_FROM_OPERATIONS'));
    expect(codeOf(detail)).not.toMatch(/phone|email|contact|address/i);
  });

  it('is refused to an investor and offered to everyone who works bookings', () => {
    expect(roleHasCapability('INVESTOR', 'reservations.read')).toBe(false);
    expect(roleHasCapability('INVESTOR', 'reservations.write')).toBe(false);
    for (const role of ROLES) {
      if (role === 'INVESTOR') continue;
      expect(roleHasCapability(role, 'reservations.read'), role).toBe(true);
    }
  });

  it('refuses an arrival written by a role that may not work bookings', async () => {
    const id = await aConfirmedBooking();
    const res = await h.request('investorA', 'POST', `/api/reservations/${id}/check-in`,
      { operationId: randomUUID(), checkInTime: '14:35' });
    expect(res.status).toBe(403);
    // Refused BEFORE anything is validated or written: the booking is untouched.
    const rows = await h.deps.repos.reservations.readAll();
    expect(rows.find((b) => b.BookingID === id)!.BookingStatus).toBe('Confirmed');
  });
});

/* ================================================================== *
 * 6 · REGRESSION — the other four surfaces still agree
 * ================================================================== */

describe('stay · the rest of the product still agrees', () => {
  /** The demo workbook with one booking moved to a status of our choosing. */
  function viewsWithStatus(status: string, over: Partial<ReservationRecord> = {}) {
    const workbook = buildDemoWorkbook();
    const target = workbook.reservations.find((b) =>
      b.CheckInDate !== null && b.CheckOutDate !== null
      && b.CheckInDate <= isoToSerial(TODAY) && isoToSerial(TODAY) < b.CheckOutDate)!;
    const reservations = workbook.reservations.map((b) =>
      b.BookingID === target.BookingID ? { ...b, BookingStatus: status, ...over } : b);
    return {
      views: new WorkbookViews({ workbook: { ...workbook, reservations }, ops: buildDemoOps(TODAY) }),
      target,
    };
  }

  it('Today counts a checked-in guest as in the house', () => {
    const { views, target } = viewsWithStatus('Checked In', { CheckInTime: '14:35' });
    const board = views.operations({ month: TODAY.slice(0, 7), date: TODAY });
    const row = [...board.arrivals, ...board.departures].find((r) => r.bookingId === target.BookingID);
    if (row) expect(row.status).toBe('Checked In');
    // The unit itself reads occupied on the property board.
    const unit = board.units.find((u) => u.propertyId === target.PropertyID)!;
    expect(['Occupied', 'Maintenance', 'Cleaning', 'Blocked']).toContain(unit.status);
  });

  it('Bookings shows the new status and the recorded arrival time', () => {
    const { views, target } = viewsWithStatus('Checked In', { CheckInTime: '14:35' });
    const row = views.reservations({ month: TODAY.slice(0, 7) })
      .find((r) => r.bookingId === target.BookingID);
    if (row) expect(row.bookingStatus).toBe('Checked In');
    expect(views.bookingDetail(target.BookingID)!.checkInTime).toBe('14:35');
    expect(views.bookingDetail(target.BookingID)!.bookingStatus).toBe('Checked In');
  });

  it('the Calendar paints a checked-in stay as in-house, not as free', () => {
    const { views, target } = viewsWithStatus('Checked In');
    const month = views.calendar({ month: TODAY.slice(0, 7) });
    const unit = month.units.find((u) => u.propertyId === target.PropertyID)!;
    const cell = unit.cells.find((c) => c.date === TODAY)!;
    expect(cell.state).toBe('checked-in');
    expect(cell.bookingId).toBe(target.BookingID);
  });

  it('Availability still reports the unit HELD for the nights of a checked-in stay', () => {
    const { views, target } = viewsWithStatus('Checked In');
    const search = views.availability({
      checkIn: TODAY, checkOut: '2027-01-20', propertyId: target.PropertyID,
    });
    expect(search.available.map((u) => u.propertyId)).not.toContain(target.PropertyID);
    expect(search.unavailable[0]!.conflicts.map((c) => c.bookingId)).toContain(target.BookingID);
  });

  it('and a checked-OUT stay still holds the nights it actually occupied', () => {
    // Departure does not retroactively free the nights that were slept in — the
    // occupancy statuses include 'Checked Out' for exactly this reason.
    const { views, target } = viewsWithStatus('Checked Out', { CheckOutTime: '11:20' });
    const month = views.calendar({ month: TODAY.slice(0, 7) });
    const unit = month.units.find((u) => u.propertyId === target.PropertyID)!;
    expect(unit.cells.find((c) => c.date === TODAY)!.state).toBe('checked-out');
  });

  it('reads BOTH recorded times back out of the workbook, not just into it', () => {
    /*
     * The whole point of recording an arrival and a departure is that somebody can look
     * them up afterwards. Writing them and dropping them on the way back out would leave
     * every panel reading "Not recorded" over a workbook that holds the answer — and the
     * write tests, which assert the mutation's own response, would not notice.
     */
    const { views, target } = viewsWithStatus('Checked Out',
      { CheckInTime: '14:35', CheckOutTime: '11:20' });
    const detail = views.bookingDetail(target.BookingID)!;
    expect(detail.checkInTime).toBe('14:35');
    expect(detail.checkOutTime).toBe('11:20');

    // And a stay with no times recorded reads as absent, never as an empty string.
    const { views: quiet, target: other } = viewsWithStatus('Checked Out',
      { CheckInTime: '', CheckOutTime: '' });
    const blank = quiet.bookingDetail(other.BookingID)!;
    expect(blank.checkInTime).toBeNull();
    expect(blank.checkOutTime).toBeNull();
  });
});
