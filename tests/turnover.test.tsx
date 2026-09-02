/**
 * UI-8 — THE TURNOVER: check-out → housekeeping → inspection → ready.
 *
 * The milestone's central question was whether a booking can be linked to the turnover
 * that follows it. It cannot, and the first block of this suite is the PROOF rather than
 * an assertion of the conclusion: the reference is optional, unvalidated, non-unique and
 * empty on every seeded row. Those four facts are what the rest of the design rests on,
 * so they are tested against the real pipeline and the real datasets.
 *
 * What must hold afterwards:
 *   · no screen claims a turnover belongs to a booking,
 *   · a reference that IS recorded is read forward, and an unresolvable one says so,
 *   · the inspection result and the cleaner — written since the form was built, never
 *     read back — are visible, verbatim, without deriving one state from another,
 *   · and the turnover register stays operational: no figure, no full name, no contact.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, within, cleanup, screen } from '@testing-library/react';
import { randomUUID } from 'node:crypto';
import { createElement, type ReactElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { HousekeepingTable } from '@/components/pages/OpsTables';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import { BookingActions } from '@/components/operations/BookingActions';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { WorkbookViews } from '@/lib/data/views/workbook-views';
import { buildDemoWorkbook, buildDemoOps } from '@/lib/data/fixtures/workbook';
import { buildDemoDataset } from '@/lib/data/demo/dataset';
import { markCleanFields } from '@/lib/server/api/form-fields';
import { HousekeepingUpdate } from '@/lib/server/api/schemas';
import { OPEN_HOUSEKEEPING_STATUSES, type HousekeepingTask } from '@/lib/shared/domain';
import { DEMO_SCENARIOS } from '@/lib/shared/environment';
import { roleHasCapability, ROLES } from '@/lib/shared/roles';
import { operationalBookingDetail, type OperationalBookingDetail } from '@/lib/data/views/role-projections';
import type { CleaningRow } from '@/lib/data/providers/types';
import { createWriteHarness, type WriteHarness } from './support/write-harness';
import { readSource as read, codeOf } from './support/source';

const TODAY = '2027-01-19';
const provider = new FixtureDashboardDataProvider({ now: () => new Date(`${TODAY}T10:00:00Z`) });

let h: WriteHarness;
beforeEach(() => { h = createWriteHarness(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * 1 · THE RELATIONSHIP — proved, not assumed
 * ================================================================== */

describe('turnover · what BookingID actually is', () => {
  it('is OPTIONAL on the write, and never checked against the register', async () => {
    // A turnover with no booking reference at all is accepted.
    const bare = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03',
    });
    expect(bare.status, JSON.stringify(bare.body)).toBe(200);

    // …and so is one naming a booking that does not exist anywhere.
    const invented = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03',
      bookingId: 'BK-9999-9999',
    });
    expect(invented.status, JSON.stringify(invented.body)).toBe(200);
    expect(invented.body.record.BookingID).toBe('BK-9999-9999');

    /*
     * The contrast that makes this a deliberate difference rather than an oversight:
     * revenue.create DOES validate its bookingId against 04_RESERVATIONS.
     */
    const revenue = await h.request('admin', 'POST', '/api/revenue', {
      operationId: randomUUID(), propertyId: 'HYD-501', date: '2026-09-03',
      revenueType: 'Room', platform: 'Airbnb', grossAmount: 1000,
      bookingId: 'BK-9999-9999',
    });
    expect(revenue.status).toBe(422);
    expect(revenue.body.error.details.join(' ')).toMatch(/no booking "BK-9999-9999" exists/);
  });

  it('is NOT unique — one booking can carry any number of turnovers', async () => {
    const bookingId = 'BK-2026-0001';
    const first = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03', bookingId,
    });
    const second = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-04', bookingId,
    });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(first.body.record.TaskID).not.toBe(second.body.record.TaskID);

    const tasks = await h.repos.housekeeping.readAll();
    expect(tasks.filter((t) => t.bookingId === bookingId)).toHaveLength(2);
  });

  it('is EMPTY on every seeded turnover, in both demonstration sources', () => {
    // The fixture workbook…
    for (const task of buildDemoOps(TODAY).housekeeping) {
      expect(task.bookingId, task.taskId).toBe('');
    }
    // …and the dataset the grid-backed demo is built from, in every scenario it offers.
    for (const scenario of DEMO_SCENARIOS) {
      for (const t of buildDemoDataset(scenario).ops.housekeeping) {
        expect(t.bookingId, `${scenario} ${t.taskId}`).toBe('');
      }
    }
    /*
     * So absence proves nothing. That is the whole reason the relationship is read
     * forward only, and the grid builder lays no BookingID cell at all.
     */
    expect(codeOf(read('lib/server/demo/workbook-grids.ts')))
      .not.toMatch(/BookingID:\s*t\./);
  });

  it('is therefore never used to answer "which turnovers belong to this booking"', async () => {
    /*
     * Stated BEHAVIOURALLY, because a source pattern is the wrong instrument here: the
     * first version of this guard scanned for a housekeeping filter mentioning a booking
     * and a fabricated join walked straight past it.
     *
     * The rule is that a turnover naming a booking must change NOTHING about that
     * booking. Same workbook, same single turnover on the same unit, one carrying the
     * reference and one not — if any backward join is ever added, these two stop being
     * equal and this fails.
     */
    const real = (await provider.getReservations({ month: '2027-01' })).data[0]!;
    const unreferenced = viewsWith([task({ propertyId: real.propertyId, bookingId: '' })])
      .bookingDetail(real.bookingId);
    const referenced = viewsWith([task({ propertyId: real.propertyId, bookingId: real.bookingId })])
      .bookingDetail(real.bookingId);

    expect(referenced).toEqual(unreferenced);
    // Belt and braces: nothing on the payload is a LIST of anything.
    for (const [key, value] of Object.entries(referenced!)) {
      expect(Array.isArray(value), `${key} must not be a collection`).toBe(false);
    }

    // And the projection has no field that could carry one.
    const projection = read('lib/data/views/role-projections.ts');
    expect(projection).not.toMatch(/turnovers|housekeepingTasks|cleaningRows/);
    expect(codeOf(read('components/operations/BookingDetailDrawer.tsx')))
      .not.toMatch(/turnovers for this booking|this booking's turnover/i);
  });
});

/* ================================================================== *
 * 2 · THE TURNOVER REGISTER
 * ================================================================== */

function viewsWith(housekeeping: HousekeepingTask[]): WorkbookViews {
  const workbook = buildDemoWorkbook();
  const ops = { ...buildDemoOps(TODAY), housekeeping };
  return new WorkbookViews({ workbook, ops });
}

const task = (over: Partial<HousekeepingTask> = {}): HousekeepingTask => ({
  taskId: 'HK-2027-0044', propertyId: 'HYD-501', checkoutDate: TODAY,
  status: 'Pending', inspectionStatus: '', cleaner: '', bookingId: '',
  ...over,
});

const rowsOf = (housekeeping: HousekeepingTask[]): CleaningRow[] =>
  viewsWith(housekeeping).operations({ month: TODAY.slice(0, 7), date: TODAY }).cleaning;

describe('turnover · the register', () => {
  it('lists the open turnovers, unit first, with the state a person acts on', () => {
    const rows = rowsOf([
      task({ status: 'Pending' }),
      task({ taskId: 'HK-2027-0045', propertyId: 'HYD-502', status: 'In Progress', cleaner: 'Lakshmi' }),
      task({ taskId: 'HK-2027-0046', propertyId: 'HYD-601', status: 'Completed' }),
    ]);
    // Completed turnovers are not outstanding work — the same open set the board uses.
    expect(rows.map((r) => r.taskId)).toEqual(['HK-2027-0044', 'HK-2027-0045']);
    expect(rows.every((r) => OPEN_HOUSEKEEPING_STATUSES.includes(r.status))).toBe(true);
    // The unit's NAME, from the property master, not just its id.
    expect(rows[0]!.unitName).toBe('5th Floor — 2 BHK');
    expect(rows[1]!.cleaner).toBe('Lakshmi');
  });

  it('shows a recorded booking reference WITH the guest, when the register holds it', async () => {
    const real = (await provider.getReservations({ month: '2027-01' })).data[0]!;
    const rows = rowsOf([task({ bookingId: real.bookingId })]);

    expect(rows[0]!.bookingRef).toBe(real.bookingId);
    expect(rows[0]!.bookingKnown).toBe(true);
    // Minimised, exactly as every list shows it.
    expect(rows[0]!.guestDisplayName).toMatch(/^\S+(\s\S\.)?$/);
    expect(rows[0]!.guestDisplayName).toBe(real.guestDisplayName);
  });

  it('says an unresolvable reference is unresolvable, rather than hiding it', () => {
    const rows = rowsOf([task({ bookingId: 'BK-9999-9999' })]);
    expect(rows[0]!.bookingRef).toBe('BK-9999-9999');
    expect(rows[0]!.bookingKnown).toBe(false);
    expect(rows[0]!.guestDisplayName).toBeNull();

    const { container } = renderUi(createElement(HousekeepingTable, { rows }));
    expect(container.textContent).toContain('BK-9999-9999');
    expect(container.textContent).toContain('not in the register');
  });

  it('distinguishes "none recorded" from "nothing to say"', () => {
    const rows = rowsOf([task()]);
    expect(rows[0]!.bookingRef).toBe('');
    expect(rows[0]!.bookingKnown).toBe(false);

    const { container } = renderUi(createElement(HousekeepingTable, { rows }));
    // In words, never an empty cell: nobody has said, which is a fact of its own.
    expect(container.textContent).toContain('None recorded');
    expect(container.textContent).toContain('Nobody yet');
  });

  it('shows the inspection result verbatim, and never derives it from the status', () => {
    const rows = rowsOf([
      task({ inspectionStatus: 'Pending' }),
      task({ taskId: 'HK-2', propertyId: 'HYD-502', status: 'Failed Inspection', inspectionStatus: 'Failed' }),
      // A turnover whose inspection nobody has recorded is NOT a pass.
      task({ taskId: 'HK-3', propertyId: 'HYD-601', status: 'In Progress', inspectionStatus: '' }),
    ]);
    expect(rows.map((r) => r.inspectionStatus)).toEqual(['Pending', 'Failed', '']);

    const { container } = renderUi(createElement(HousekeepingTable, { rows }));
    expect(container.textContent).toContain('Not recorded');

    // `Failed Inspection` stays a FinalStatus value; the two are related, not redundant.
    expect(rows[1]!.status).toBe('Failed Inspection');
  });

  it('offers only the action the server actually supports', () => {
    const rows = rowsOf([task({ status: 'Pending' })]);
    const { container } = renderUi(createElement(HousekeepingTable, { rows }));
    expect(within(container).getByRole('button', { name: 'Mark clean' })).toBeTruthy();
    // No fake control: assignment and inspection are fields of that one mutation.
    expect(within(container).queryByRole('button', { name: /Assign/ })).toBeNull();
    expect(within(container).queryByRole('button', { name: /Inspect/ })).toBeNull();

    // And the fields it asks for are exactly what `housekeeping.update` accepts.
    for (const field of markCleanFields()) {
      expect(HousekeepingUpdate.shape, field.name).toHaveProperty(field.name);
    }
  });

  it('FINISHES the turnover: the form the register offers takes it off the list', async () => {
    /*
     * This is the bug UI-8 found. "Mark clean" wrote the cleaner and the inspection and
     * left FinalStatus untouched, so the toast said the unit was ready while the task
     * stayed Pending and never left the outstanding list. The guarantee is behavioural:
     * submit EXACTLY the fields the register offers, and the turnover must be finished.
     */
    const created = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03',
    });
    const id = created.body.record.TaskID as string;

    const submitted: Record<string, unknown> = { operationId: randomUUID() };
    for (const field of markCleanFields()) {
      submitted[field.name] = field.defaultValue ?? 'Somebody';
    }
    const res = await h.request('operations', 'PATCH', `/api/housekeeping/${id}`, submitted);
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    const stored = (await h.repos.housekeeping.readAll()).find((t) => t.taskId === id)!;
    expect(OPEN_HOUSEKEEPING_STATUSES, `${stored.status} is still outstanding work`)
      .not.toContain(stored.status);
  });

  it('stacks record-by-record on a phone rather than scrolling sideways', () => {
    const src = codeOf(read('components/pages/OpsTables.tsx'));
    const block = src.slice(src.indexOf('export function HousekeepingTable'),
      src.indexOf('function TurnoverFacts'));
    expect(block).toContain('mobile="stack"');
  });
});

/* ================================================================== *
 * 3 · THE BOOKING PANEL — unit-level, and labelled as such
 * ================================================================== */

const refresh = vi.fn();
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {}, refresh,
  replace: () => {},
} as unknown as AppRouterInstance;

function renderUi(ui: ReactElement) {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/reservations' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams('booking=BK-1') },
          createElement(ToastProvider, null, ui)))),
  );
}

const booking = (over: Partial<OperationalBookingDetail> = {}): OperationalBookingDetail => ({
  bookingId: 'BK-1', platform: 'Airbnb', platformRef: 'AI1',
  propertyId: 'HYD-501', unitName: '5th Floor — 2 BHK', bookingStatus: 'Checked Out',
  guestDisplayName: 'Priya S.', adults: 2, children: 0, guests: 2,
  bookedOn: null, checkIn: '2027-02-10', checkOut: '2027-02-13', nights: 3,
  checkInTime: '14:35', checkOutTime: '11:20', earlyCheckIn: null, lateCheckout: null,
  guestVerification: null, damageReport: null, maintenanceRequired: null, notes: null,
  unitState: {
    housekeeping: 'In Progress', housekeepingTaskId: 'HK-2027-0044',
    housekeepingInspection: 'Pending', housekeepingCleaner: 'Lakshmi',
    openMaintenance: 1, maintenancePriority: 'High', maintenanceHeadline: 'Bedroom AC not cooling',
  },
  ...over,
});

describe('turnover · the booking panel', () => {
  it('answers who is handling the unit and what state it is in', () => {
    const { container } = renderUi(createElement(BookingDetailDrawer, {
      detail: booking(), requestedId: 'BK-1',
    }));
    const get = (label: string) =>
      within(container).getByText(label).nextElementSibling!.textContent;

    expect(get('Turnover')).toBe('In Progress');
    expect(get('Inspection')).toBe('Pending');
    expect(get('Turnover assigned to')).toBe('Lakshmi');
    expect(get('Open maintenance')).toBe('1 open · High priority');
  });

  it('titles that section for the UNIT, and claims nothing about the stay', () => {
    const { container } = renderUi(createElement(BookingDetailDrawer, {
      detail: booking(), requestedId: 'BK-1',
    }));
    const headings = [...container.querySelectorAll('.sv-bkdetail__heading')]
      .map((n) => n.textContent);
    expect(headings).toContain('This unit, right now');
    // Not "this stay's turnover", which the data cannot support.
    for (const heading of headings) {
      expect(heading).not.toMatch(/this (stay|booking)'?s? turnover/i);
    }
    expect(container.textContent).not.toMatch(/turnover for this booking/i);
  });

  it('offers the EXISTING next step after a departure, not an invented automation', () => {
    renderUi(createElement(BookingActions, { booking: booking({ bookingStatus: 'Checked Out' }) }));
    const link = screen.getByRole('link', { name: /Turnovers for 5th Floor/ });
    expect(link.getAttribute('href')).toBe('/admin/operations/housekeeping?property=HYD-501');

    /*
     * And nothing chains one mutation to another: checking out writes to the reservation
     * and stops. No screen and no handler creates a turnover on the guest's behalf.
     */
    const services = codeOf(read('lib/server/api/mutation-services.ts'));
    const checkOut = services.slice(services.indexOf("'reservation.checkOut'"),
      services.indexOf("'reservation.cancel'"));
    expect(checkOut).not.toMatch(/housekeeping|HOUSEKEEPING|TaskID/);
  });

  it('shows no next step while the guest is still in the house', () => {
    renderUi(createElement(BookingActions, { booking: booking({ bookingStatus: 'Checked In' }) }));
    expect(screen.queryByRole('link', { name: /Turnovers for/ })).toBeNull();
  });
});

/* ================================================================== *
 * 4 · DISCLOSURE
 * ================================================================== */

describe('turnover · disclosure', () => {
  it('carries no financial field and no full guest name', async () => {
    const real = (await provider.getReservations({ month: '2027-01' })).data[0]!;
    const rows = rowsOf([task({ bookingId: real.bookingId })]);
    const serialised = JSON.stringify(rows);

    for (const field of [
      'grossValue', 'expectedPayout', 'actualPayout', 'payoutStatus', 'BaseRate',
      'RoomRevenue', 'CleaningFee', 'Discount', 'Taxes', 'PlatformFee', 'amount', 'cost',
    ]) {
      expect(serialised, field).not.toContain(field);
    }

    const detail = await provider.getBookingDetail(real.bookingId);
    const full = detail.data!.guestDisplayName;
    expect(rows[0]!.guestDisplayName).toBe(full);
    expect(rows[0]!.guestDisplayName).toMatch(/^\S+(\s\S\.)?$/);

    const client = codeOf(read('components/pages/OpsTables.tsx'));
    expect(client).not.toMatch(/guestName|payout|grossValue|₹|phone|email|contact/i);
  });

  it('is guarded by housekeeping.read, which an investor does not hold', () => {
    expect(read('app/admin/operations/housekeeping/page.tsx'))
      .toContain('capability="housekeeping.read"');
    expect(roleHasCapability('INVESTOR', 'housekeeping.read')).toBe(false);
    expect(roleHasCapability('INVESTOR', 'housekeeping.write')).toBe(false);
    for (const role of ROLES) {
      if (role === 'INVESTOR') continue;
      expect(roleHasCapability(role, 'housekeeping.read'), role).toBe(true);
    }
  });

  it('refuses a turnover written by a role that may not work them', async () => {
    const res = await h.request('investorA', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03',
    });
    expect(res.status).toBe(403);
  });

  it('re-reads authoritatively after a mark-clean rather than showing a stale row', async () => {
    const created = await h.request('operations', 'POST', '/api/housekeeping', {
      operationId: randomUUID(), propertyId: 'HYD-501', checkoutDate: '2026-09-03',
    });
    const id = created.body.record.TaskID as string;
    expect(created.body.record.FinalStatus).toBe('Pending');

    const done = await h.request('operations', 'PATCH', `/api/housekeeping/${id}`, {
      operationId: randomUUID(), cleaner: 'Lakshmi',
      inspectionStatus: 'Passed', finalStatus: 'Completed',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    // The response IS the row read back — and the inspection survives the round trip.
    expect(done.body.meta.verified).toBe(true);
    expect(done.body.record.FinalStatus).toBe('Completed');
    expect(done.body.record.InspectionStatus).toBe('Passed');
    expect(done.body.record.Cleaner).toBe('Lakshmi');

    const stored = (await h.repos.housekeeping.readAll()).find((t) => t.taskId === id)!;
    expect(stored.status).toBe('Completed');
    expect(stored.inspectionStatus).toBe('Passed');
    expect(stored.cleaner).toBe('Lakshmi');

    // A completed turnover leaves the outstanding list: the board moves with the write.
    expect(OPEN_HOUSEKEEPING_STATUSES).not.toContain('Completed');
  });
});
