/**
 * BOOKING LIFECYCLE ACTIONS — every step a booking can legally take next.
 *
 * A SERVER component: the field specs come from the V1 contract on this side of the
 * wire, and each control is the existing verified write path — one operation id per
 * opened intent, no optimistic state, `router.refresh()` as the authoritative re-read.
 * Nothing here computes a booking state; the server re-checks every transition on
 * submit, so an action the row should not have offered comes back as a readable 422.
 *
 * WHAT IS DELIBERATELY ABSENT:
 *   - ActualPayout and PayoutDate. `PATCH /api/reservations/:id` accepts both and
 *     OPERATIONS holds `reservations.write`, so the role that may not READ a payout can
 *     currently SET one through the API. That asymmetry is a business decision and it
 *     has not been approved, so no screen offers it.
 *   - BaseRate, RoomRevenue, CleaningFee, ExtraGuestFee, Discount, Taxes, PlatformFee,
 *     OtherDeductions. Booking money is entered on the finance view of the register.
 *   - The guest's full name as a prefilled value. The product never discloses one, so
 *     prefilling would mean writing the minimised form back over the real name.
 */
import { RowActionButton } from '@/components/mutations/actions';
import {
  checkInFields, checkOutFields, cancelReservationFields, noShowFields,
  extendStayFields, editBookingFields,
} from '@/lib/server/api/form-fields';
import type { OperationalBookingDetail } from '@/lib/data/views/role-projections';

/**
 * The one legal next step, from the SAME transition table the server enforces
 * (Inquiry → Confirmed → Checked In → Checked Out). Null once the stay is over.
 */
function nextStep(status: string): 'confirm' | 'check-in' | 'check-out' | null {
  if (status === 'Inquiry') return 'confirm';
  if (status === 'Confirmed') return 'check-in';
  if (status === 'Checked In') return 'check-out';
  return null;
}

/**
 * What a finished booking says about itself.
 *
 * Written out rather than interpolated: "This booking is no show" is what lower-casing a
 * status gets you, and a status is a label, not a predicate.
 */
const CLOSED_SENTENCE: Record<string, string> = {
  'Checked Out': 'The stay is complete.',
  'Cancelled': 'This booking was cancelled.',
  'No Show': 'The guest did not arrive.',
};

/** A booking that has reached a terminal status takes no further action. */
function isOpen(status: string): boolean {
  return status === 'Inquiry' || status === 'Confirmed' || status === 'Checked In';
}

export function BookingActions({ booking }: { booking: OperationalBookingDetail }) {
  const base = `/api/reservations/${booking.bookingId}`;
  const step = nextStep(booking.bookingStatus);
  /* A cancellation and a no-show are both legal only before the guest is in the house —
     `Checked In` may only go to `Checked Out`, which the server enforces. */
  const abandonable = booking.bookingStatus === 'Inquiry' || booking.bookingStatus === 'Confirmed';

  if (!isOpen(booking.bookingStatus)) {
    return (
      <p className="sv-bkdetail__closed">
        {CLOSED_SENTENCE[booking.bookingStatus] ?? `This booking is ${booking.bookingStatus}.`}
        {' '}Nothing further can be done here — the row stays in the ledger as a record of
        what happened.
      </p>
    );
  }

  return (
    <>
      {/* ---- the one primary step ---- */}
      {step === 'confirm' ? (
        <RowActionButton
          label="Confirm booking" variant="primary" size="md" method="PATCH"
          endpoint={base}
          /* The transition IS the action; there is nothing for a person to restate. */
          constants={{ bookingStatus: 'Confirmed' }}
          successTemplate={`${booking.bookingId} confirmed.`}
        />
      ) : null}

      {step === 'check-in' ? (
        <RowActionButton
          label="Check in" variant="primary" size="md"
          endpoint={`${base}/check-in`}
          confirmTitle={`Check in ${booking.guestDisplayName}`}
          fields={checkInFields()}
          successTemplate={`${booking.guestDisplayName} is checked in.`}
        />
      ) : null}

      {step === 'check-out' ? (
        <RowActionButton
          label="Check out" variant="primary" size="md"
          endpoint={`${base}/check-out`}
          confirmTitle={`Check out ${booking.guestDisplayName}`}
          fields={checkOutFields()}
          successTemplate={`${booking.guestDisplayName} is checked out — the unit needs a turnover.`}
        />
      ) : null}

      {/* ---- secondary: amend ---- */}
      <RowActionButton
        label="Edit stay" variant="secondary" size="md" method="PATCH"
        endpoint={base}
        confirmTitle={`Edit ${booking.bookingId}`}
        fields={editBookingFields(booking)}
        successTemplate={`${booking.bookingId} updated.`}
      />

      <RowActionButton
        label="Change dates" variant="secondary" size="md" method="PATCH"
        endpoint={base}
        confirmTitle={`Extend or shorten ${booking.bookingId}`}
        fields={extendStayFields(booking.checkOut)}
        successTemplate={`${booking.bookingId} now departs on the new date.`}
      />

      {/* ---- secondary: end the booking without a stay ---- */}
      {abandonable ? (
        <>
          <RowActionButton
            label="Cancel booking" variant="danger" size="md"
            endpoint={`${base}/cancel`}
            confirmTitle={`Cancel ${booking.bookingId}?`}
            fields={cancelReservationFields()}
            successTemplate={`${booking.bookingId} cancelled — the row remains in the ledger.`}
          />
          <RowActionButton
            label="Mark no-show" variant="danger" size="md"
            endpoint={`${base}/cancel`}
            confirmTitle={`${booking.guestDisplayName} did not arrive`}
            fields={noShowFields()}
            /* The flag that makes this a no-show rather than a cancellation. The server
               moves the status to "No Show", which the cancellation rate counts as a
               lost booking exactly as it counts a cancellation. */
            constants={{ noShow: true }}
            successTemplate={`${booking.bookingId} recorded as a no-show.`}
          />
        </>
      ) : null}
    </>
  );
}
