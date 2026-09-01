/**
 * UI-4 — THE BOOKING LIFECYCLE.
 *
 * Every step a booking can legally take, and — just as important — the ones no screen
 * offers because they have not been approved.
 *
 * Two decisions from the booking-domain audit were explicitly NOT approved, and this
 * suite is where they stay unapproved:
 *
 *   1. OPERATIONS may not write ActualPayout or PayoutDate. The API still accepts both
 *      under `reservations.write`, which OPERATIONS holds, so the guard has to be that
 *      no screen offers the fields — asserted here against the form specs themselves.
 *   2. Full guest names are not disclosed. The edit form therefore offers the name
 *      BLANK, because prefilling it would write the minimised form back over the real
 *      one and destroy it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactElement } from 'react';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { ToastProvider } from '@/components/ui/toast';
import { BookingActions } from '@/components/operations/BookingActions';
import { BookingDetailDrawer } from '@/components/operations/BookingDetailDrawer';
import {
  cancelReservationFields, noShowFields, extendStayFields, editBookingFields,
  checkInFields, checkOutFields, reservationFields,
} from '@/lib/server/api/form-fields';
import { RESERVATION_TRANSITIONS } from '@/lib/server/api/schemas';
import type { OperationalBookingDetail } from '@/lib/data/views/role-projections';
import { readSource as read, codeOf } from './support/source';

/** Money columns no operations surface may offer. The audit's decision 1, as a list. */
const FORBIDDEN_FIELDS = [
  'actualPayout', 'payoutDate', 'baseRate', 'roomRevenue', 'cleaningFee',
  'extraGuestFee', 'discount', 'taxes', 'platformFee', 'otherDeductions',
  'grossBookingValue', 'expectedPayout', 'payoutStatus', 'payoutVariance',
];

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
      createElement(PathnameContext.Provider, { value: '/admin/operations/reservations' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

const booking = (over: Partial<OperationalBookingDetail> = {}): OperationalBookingDetail => ({
  bookingId: 'BK-2027-0001', platform: 'Airbnb', platformRef: 'AI100001',
  propertyId: 'HYD-501', unitName: '5th Floor — 2 BHK', bookingStatus: 'Confirmed',
  guestDisplayName: 'Priya S.', adults: 2, children: 1, guests: 3,
  bookedOn: null, checkIn: '2027-02-10', checkOut: '2027-02-13', nights: 3,
  checkInTime: null, checkOutTime: null, earlyCheckIn: null, lateCheckout: null,
  guestVerification: null, damageReport: null, maintenanceRequired: null, notes: null,
  unitState: { housekeeping: null, openMaintenance: 0, maintenancePriority: null, maintenanceHeadline: null },
  ...over,
});

/** The action buttons offered for a booking in a given state. */
function actionsFor(status: string): { labels: string[]; container: HTMLElement } {
  const { container } = renderUi(
    createElement(BookingActions, { booking: booking({ bookingStatus: status }) }),
  );
  return {
    labels: within(container).queryAllByRole('button').map((b) => b.textContent!.trim()),
    container,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  cleanup();
  refresh.mockClear();
  replaced.length = 0;
  fetchMock = vi.fn(async () => new Response(
    JSON.stringify({ record: { BookingID: 'BK-2027-0001' }, meta: { verified: true } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  ));
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('crypto', { ...globalThis.crypto, randomUUID: () => '11111111-2222-4333-8444-555555555555' });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const bodyOf = (call: number) => JSON.parse(fetchMock.mock.calls[call]![1]!.body as string);
const urlOf = (call: number) => String(fetchMock.mock.calls[call]![0]);

/* ================================================================== *
 * ONE LEGAL NEXT STEP
 * ================================================================== */

describe('booking lifecycle · what a booking may do next', () => {
  it('offers exactly the transition the server would accept, and no other', () => {
    const primary: Record<string, string | null> = {
      'Inquiry': 'Confirm booking',
      'Confirmed': 'Check in',
      'Checked In': 'Check out',
      'Checked Out': null,
      'Cancelled': null,
      'No Show': null,
    };

    for (const [status, expected] of Object.entries(primary)) {
      const { labels } = actionsFor(status);
      if (expected) {
        expect(labels, status).toContain(expected);
        // The transition table the server enforces must agree that this is legal.
        expect(RESERVATION_TRANSITIONS[status]!.length, status).toBeGreaterThan(0);
      } else {
        expect(RESERVATION_TRANSITIONS[status], status).toEqual([]);
        expect(labels, status).toEqual([]);
      }
      cleanup();
    }
  });

  it('says what happened when a booking is finished, in words that fit the status', () => {
    for (const [status, sentence] of Object.entries({
      'Checked Out': 'The stay is complete.',
      'Cancelled': 'This booking was cancelled.',
      'No Show': 'The guest did not arrive.',
    })) {
      const { container } = actionsFor(status);
      // Not `status.toLowerCase()` in a sentence — that yields "this booking is no show".
      expect(container.textContent, status).toContain(sentence);
      expect(container.textContent, status).toContain('the row stays in the ledger');
      cleanup();
    }
  });

  it('offers cancel and no-show only while the guest is not yet in the house', () => {
    for (const status of ['Inquiry', 'Confirmed']) {
      const { labels } = actionsFor(status);
      expect(labels, status).toContain('Cancel booking');
      expect(labels, status).toContain('Mark no-show');
      cleanup();
    }
    // `Checked In` may only go to `Checked Out` — the server's own table says so.
    expect(RESERVATION_TRANSITIONS['Checked In']).toEqual(['Checked Out']);
    const inHouse = actionsFor('Checked In');
    expect(inHouse.labels).not.toContain('Cancel booking');
    expect(inHouse.labels).not.toContain('Mark no-show');
  });

  it('always allows amending an open booking', () => {
    for (const status of ['Inquiry', 'Confirmed', 'Checked In']) {
      const { labels } = actionsFor(status);
      expect(labels, status).toContain('Edit stay');
      expect(labels, status).toContain('Change dates');
      cleanup();
    }
  });
});

/* ================================================================== *
 * THE ACTIONS THEMSELVES
 * ================================================================== */

describe('booking lifecycle · the writes', () => {
  it('confirms an inquiry by PATCHing the status, with nothing for a person to restate', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(
      createElement(BookingActions, { booking: booking({ bookingStatus: 'Inquiry' }) }),
    );

    await user.click(within(container).getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(urlOf(0)).toBe('/api/reservations/BK-2027-0001');
    expect(fetchMock.mock.calls[0]![1]!.method).toBe('PATCH');
    expect(bodyOf(0).bookingStatus).toBe('Confirmed');
    expect(bodyOf(0).operationId).toBeDefined();
  });

  it('sends noShow: true — the flag is what makes it a no-show and not a cancellation', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));

    await user.click(within(container).getByRole('button', { name: 'Mark no-show' }));
    await user.type(screen.getByLabelText(/What happened/), 'Guest never arrived');
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(urlOf(0)).toBe('/api/reservations/BK-2027-0001/cancel');
    expect(bodyOf(0).noShow).toBe(true);
    expect(bodyOf(0).reason).toBe('Guest never arrived');
  });

  it('cancels WITHOUT the no-show flag — the two are different outcomes', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));

    await user.click(within(container).getByRole('button', { name: 'Cancel booking' }));
    await user.type(screen.getByLabelText(/Why is this booking being cancelled/), 'Guest asked to cancel');
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(bodyOf(0).noShow).toBeUndefined();
    expect(bodyOf(0).reason).toBe('Guest asked to cancel');
  });

  it('changes the departure date and nothing else', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));

    await user.click(within(container).getByRole('button', { name: 'Change dates' }));
    const field = screen.getByLabelText(/New check-out date/) as HTMLInputElement;
    // Prefilled with the stay as it stands, so a person edits rather than retypes.
    expect(field.value).toBe('2027-02-13');

    await user.clear(field);
    await user.type(field, '2027-02-16');
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    const sent = bodyOf(0);
    expect(sent.checkOutDate).toBe('2027-02-16');
    // No figure travels with a length change; the workbook recalculates from the dates.
    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(Object.keys(sent), forbidden).not.toContain(forbidden);
    }
  });

  it('re-reads from the server after a verified write instead of guessing', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(
      createElement(BookingActions, { booking: booking({ bookingStatus: 'Inquiry' }) }),
    );
    await user.click(within(container).getByRole('button', { name: 'Confirm booking' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
  });

  it('cannot be fired twice for one intent', async () => {
    const user = userEvent.setup();
    let release: (() => void) | undefined;
    fetchMock.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve(new Response(
        JSON.stringify({ record: {}, meta: { verified: true } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ));
    }));

    const { container } = renderUi(
      createElement(BookingActions, { booking: booking({ bookingStatus: 'Inquiry' }) }),
    );
    const button = within(container).getByRole('button', { name: 'Confirm booking' });
    await user.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    await user.click(button).catch(() => { /* disabled — that is the point */ });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    release?.();
  });

  it('keeps a refusal on screen with its operation id rather than claiming success', async () => {
    const user = userEvent.setup();
    fetchMock.mockResolvedValue(new Response(
      JSON.stringify({ error: {
        code: 'BUSINESS_VALIDATION', message: 'The request is not valid.',
        details: ['checkOutDate must be after checkInDate.'],
      } }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    ));

    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));
    await user.click(within(container).getByRole('button', { name: 'Change dates' }));
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);

    await waitFor(() => {
      expect(document.querySelector('.sv-mutation-form__failure')).toBeTruthy();
    });
    const failure = document.querySelector('.sv-mutation-form__failure')!;
    expect(failure.textContent).toContain('checkOutDate must be after checkInDate.');
    expect(failure.textContent).toContain('Operation ');
    expect(refresh).not.toHaveBeenCalled();
  });
});

/* ================================================================== *
 * DECISION 1 — OPERATIONS MAY NOT WRITE A PAYOUT
 * ================================================================== */

describe('booking lifecycle · no money on an operations surface', () => {
  it('no lifecycle form offers a single financial field', () => {
    const forms: Array<[string, ReturnType<typeof checkInFields>]> = [
      ['check-in', checkInFields()],
      ['check-out', checkOutFields()],
      ['cancel', cancelReservationFields()],
      ['no-show', noShowFields()],
      ['change dates', extendStayFields('2027-02-13')],
      ['edit stay', editBookingFields(booking())],
    ];

    for (const [name, fields] of forms) {
      const names = fields.map((f) => f.name);
      for (const forbidden of FORBIDDEN_FIELDS) {
        expect(names, `${name} must not offer ${forbidden}`).not.toContain(forbidden);
      }
      // Nor by type: a currency control on one of these forms is money by another name.
      expect(fields.filter((f) => f.type === 'currency'), name).toEqual([]);
    }
  });

  it('the operations create form omits the money columns entirely', () => {
    const ops = reservationFields(['HYD-501'], ['Airbnb'], { withValues: false });
    for (const forbidden of FORBIDDEN_FIELDS) {
      expect(ops.map((f) => f.name), forbidden).not.toContain(forbidden);
    }
    expect(ops.filter((f) => f.type === 'currency')).toEqual([]);
    // Omitted, not hidden: absent from the form, the payload and the browser.
    expect(read('app/admin/operations/reservations/page.tsx')).toContain('withValues: false');
  });

  it('keeps the money columns on the FINANCE view of the same register', () => {
    // Removing them from operations without providing them here would have made a
    // booking's value unenterable: reservation.update accepts no rate or fee either.
    const finance = reservationFields(['HYD-501'], ['Airbnb']);
    for (const expected of ['baseRate', 'roomRevenue', 'cleaningFee', 'extraGuestFee', 'discount']) {
      expect(finance.map((f) => f.name), expected).toContain(expected);
    }
    const ledger = read('app/admin/reservations/page.tsx');
    expect(ledger).toContain('reservationFields(propertyIds, platforms)');
    // Gated on a financial capability, decided on the server.
    expect(ledger).toContain("checkPageAccess('revenue.read')");
  });

  it('offers no way to set a payout, on any screen, in any form', () => {
    for (const file of [
      'components/operations/BookingActions.tsx',
      'components/operations/BookingsWorkspace.tsx',
      'components/operations/BookingDetailDrawer.tsx',
    ]) {
      const src = codeOf(read(file));
      expect(src, file).not.toMatch(/actualPayout|payoutDate/i);
    }
  });
});

/* ================================================================== *
 * DECISION 2 — NO FULL GUEST NAME
 * ================================================================== */

describe('booking lifecycle · the guest name is never disclosed, and never destroyed', () => {
  it('offers the name BLANK, so an untouched form cannot overwrite the real one', () => {
    const field = editBookingFields(booking()).find((f) => f.name === 'guestName')!;
    expect(field).toBeDefined();
    // Prefilling would mean writing back "Priya S." — the minimised form — over the
    // full name the workbook holds and this product never shows.
    expect(field.defaultValue).toBeUndefined();
    expect(field.required).toBeFalsy();
    expect(field.help).toContain('not shown here');
  });

  it('sends nothing for a name the person did not type', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));

    await user.click(within(container).getByRole('button', { name: 'Edit stay' }));
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    // An empty field is omitted, not sent as '' — an empty write would blank the cell.
    expect(Object.keys(bodyOf(0))).not.toContain('guestName');
    expect(bodyOf(0).adults).toBe(2);
    expect(bodyOf(0).children).toBe(1);
  });

  it('replaces the name only when somebody actually types one', async () => {
    const user = userEvent.setup();
    const { container } = renderUi(createElement(BookingActions, { booking: booking() }));

    await user.click(within(container).getByRole('button', { name: 'Edit stay' }));
    await user.type(screen.getByLabelText(/Correct the guest name/), 'Priya Sharma');
    await user.click(document.querySelector('.sv-modal button[type=submit]') as HTMLElement);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());

    expect(bodyOf(0).guestName).toBe('Priya Sharma');
  });

  it('prefills only what the panel already shows', () => {
    const fields = editBookingFields(booking({ notes: 'Late arrival expected' }));
    const byName = Object.fromEntries(fields.map((f) => [f.name, f.defaultValue]));
    expect(byName.adults).toBe('2');
    expect(byName.children).toBe('1');
    expect(byName.checkInDate).toBe('2027-02-10');
    expect(byName.checkOutDate).toBe('2027-02-13');
    expect(byName.notes).toBe('Late arrival expected');
  });
});

/* ================================================================== *
 * NESTED OVERLAYS
 * ================================================================== */

describe('booking lifecycle · a dialog opened from the detail panel', () => {
  it('closes ITSELF on Escape, leaving the panel underneath it open', async () => {
    const user = userEvent.setup();
    renderUi(createElement(BookingDetailDrawer, {
      detail: booking(), requestedId: 'BK-2027-0001',
      actions: createElement(BookingActions, { booking: booking() }),
    }), 'booking=BK-2027-0001');

    expect(document.querySelector('.sv-drawer')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Cancel booking' }));
    expect(document.querySelector('.sv-modal')).toBeTruthy();

    await user.keyboard('{Escape}');
    // Every trap listens on document in the capture phase; without a stack the drawer's
    // handler ran first and closed the wrong surface.
    expect(document.querySelector('.sv-modal')).toBeNull();
    expect(document.querySelector('.sv-drawer')).toBeTruthy();
  });

  it('keeps the page behind locked while any surface is still open', async () => {
    const user = userEvent.setup();
    renderUi(createElement(BookingDetailDrawer, {
      detail: booking(), requestedId: 'BK-2027-0001',
      actions: createElement(BookingActions, { booking: booking() }),
    }), 'booking=BK-2027-0001');

    await user.click(screen.getByRole('button', { name: 'Cancel booking' }));
    await user.keyboard('{Escape}');
    expect(document.body.style.overflow).toBe('hidden');
  });
});
