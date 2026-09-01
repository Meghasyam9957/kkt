/**
 * BOOKING STATUS VOCABULARY — one status-to-tone map for the whole product.
 *
 * Three implementations of this used to exist and two of them disagreed: a `Cancelled`
 * booking rendered `bad` on the operations register and `warn` on the finance ledger, so
 * the colour of a pill depended on which screen you happened to be reading. A status
 * system that changes meaning between screens is not a status system.
 *
 * The tones follow the DOMAIN's own grouping rather than a per-screen opinion:
 *
 *   Inquiry      warn     — on nobody's books yet; someone has to decide
 *   Confirmed    info     — on the books, nothing to do until the day
 *   Checked In   good     — in house, the normal healthy state of a live stay
 *   Checked Out  neutral  — complete; a finished stay is not an alert
 *   Cancelled    bad      — a lost booking (domain.ts CANCELLED_STATUSES)
 *   No Show      bad      — a lost booking, the same class, so the same tone
 *
 * `Cancelled` and `No Show` share a tone deliberately: `CANCELLED_STATUSES` groups them
 * as one thing — bookings V1 counts as lost — and a vocabulary that splits a domain class
 * across two hues has stopped describing the domain.
 *
 * Colour is never the only signal: `StatusPill` always renders the status WORD, and the
 * dot is `aria-hidden`. This map decides emphasis, not meaning.
 */
// Type-only, so this stays a data module with no component runtime attached to it.
import type { Tone } from '@/components/ui/primitives';
import type { BookingStatus } from './domain';

export const BOOKING_STATUS_TONE: Readonly<Record<BookingStatus, Tone>> = {
  'Inquiry': 'warn',
  'Confirmed': 'info',
  'Checked In': 'good',
  'Checked Out': 'neutral',
  'Cancelled': 'bad',
  'No Show': 'bad',
};

/**
 * Lifecycle order, for sorting a list BY status.
 *
 * Alphabetical would put Cancelled first and Confirmed second, which tells the reader
 * nothing. This is the order a booking actually travels in — the same progression the
 * server's transition table enforces — so sorting by status groups a list into "not
 * decided yet", "on the books", "in the house", "done", "lost".
 */
export const BOOKING_STATUS_ORDER: readonly BookingStatus[] = [
  'Inquiry', 'Confirmed', 'Checked In', 'Checked Out', 'Cancelled', 'No Show',
];

/** Sort rank for a status. An unrecognised one sorts last rather than first. */
export function bookingStatusRank(status: string): number {
  const index = BOOKING_STATUS_ORDER.indexOf(status as BookingStatus);
  return index === -1 ? BOOKING_STATUS_ORDER.length : index;
}

/**
 * The tone for a booking status.
 *
 * Takes a `string` rather than `BookingStatus` because the workbook is the source of
 * truth for this vocabulary and a hand-typed cell can hold anything. An unrecognised
 * status renders `neutral` — visually quiet — rather than throwing or, worse, borrowing
 * the emphasis of a status it is not.
 */
export function bookingStatusTone(status: string): Tone {
  return BOOKING_STATUS_TONE[status as BookingStatus] ?? 'neutral';
}
