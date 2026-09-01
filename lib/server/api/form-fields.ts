import '@/lib/server/only';
/**
 * FORM FIELD SPECS — the server-side bridge between the V1 contract and the browser.
 *
 * Every option list comes from the generated `LISTS`, so a vocabulary change in the
 * workbook reaches the forms through contract regeneration, never a UI edit. Every
 * field here corresponds to a `role: in` column of its target sheet — the same rule the
 * pipeline enforces — and the specs are plain JSON, handed to client components as
 * props. The browser never imports the contract.
 *
 * Nothing here computes: derived money (totals, fees, payouts) has no field, because
 * the workbook owns it.
 */
import { LISTS } from '@/lib/contract/contract.generated';
import type { FieldSpec } from '@/components/mutations/MutationForm';

const list = (name: keyof typeof LISTS): Array<{ value: string }> =>
  (LISTS[name] as readonly string[]).map((value) => ({ value }));

const propertyOptions = (ids: readonly string[], withCommon: boolean) => [
  ...(withCommon ? [{ value: 'COMMON', label: 'COMMON (shared)' }] : []),
  ...ids.map((value) => ({ value })),
];

const today = (): string => new Date().toISOString().slice(0, 10);

/* ------------------------------------------------------------------ *
 * Finance
 * ------------------------------------------------------------------ */

export function expenseFields(propertyIds: readonly string[]): FieldSpec[] {
  return [
    { name: 'date', label: 'Date', type: 'date', required: true, defaultValue: today() },
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, true) },
    { name: 'expenseCategory', label: 'Category', type: 'select', required: true, options: list('EXPENSE_CATEGORY') },
    { name: 'expenseSubcategory', label: 'Subcategory', type: 'text', required: true, placeholder: 'Electricity, Housekeeping, Internet…' },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'vendor', label: 'Vendor', type: 'text' },
    { name: 'amount', label: 'Amount', type: 'currency', required: true },
    { name: 'tax', label: 'Tax', type: 'currency', help: 'GST or other tax on this bill, if any.' },
    { name: 'paymentMethod', label: 'Payment method', type: 'select', options: list('PAYMENT_METHOD') },
    { name: 'paymentStatus', label: 'Payment status', type: 'select', required: true, options: list('PAYMENT_STATUS'), defaultValue: 'Paid' },
    { name: 'paidDate', label: 'Paid on', type: 'date' },
    { name: 'recurring', label: 'Recurring', type: 'select', options: list('RECURRING') },
    {
      name: 'expenseType', label: 'Expense type', type: 'select', required: true,
      options: list('EXPENSE_TYPE'), defaultValue: 'Operating',
      help: 'Operating reaches the P&L. CAPEX belongs in 07_CAPEX — the QA sheet flags misfiled rows.',
    },
  ];
}

export function revenueFields(propertyIds: readonly string[], platforms: readonly string[]): FieldSpec[] {
  return [
    { name: 'date', label: 'Date', type: 'date', required: true, defaultValue: today() },
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, false) },
    { name: 'revenueType', label: 'Revenue type', type: 'select', required: true, options: list('REVENUE_TYPE') },
    { name: 'platform', label: 'Platform', type: 'select', required: true, options: platforms.map((value) => ({ value })) },
    { name: 'bookingId', label: 'Booking ID', type: 'text', placeholder: 'BK-2027-0001 (optional)', help: 'Link to the booking where one exists.' },
    { name: 'grossAmount', label: 'Gross amount', type: 'currency', required: true },
    { name: 'payoutStatus', label: 'Payout status', type: 'select', required: true, options: list('PAYOUT_STATUS'), defaultValue: 'Pending' },
    { name: 'payoutDate', label: 'Payout date', type: 'date' },
    { name: 'paymentAccount', label: 'Payment account', type: 'text' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function capexFields(propertyIds: readonly string[]): FieldSpec[] {
  return [
    { name: 'date', label: 'Date', type: 'date', required: true, defaultValue: today() },
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, true) },
    { name: 'category', label: 'Category', type: 'select', required: true, options: list('CAPEX_CATEGORY') },
    { name: 'item', label: 'Item', type: 'text', required: true, placeholder: 'Split AC 1.5T, queen mattress…' },
    { name: 'quantity', label: 'Quantity', type: 'number', required: true, min: 1, max: 999, defaultValue: '1' },
    { name: 'unitCost', label: 'Unit cost', type: 'currency', required: true },
    { name: 'vendor', label: 'Vendor', type: 'text' },
    { name: 'paymentStatus', label: 'Payment status', type: 'select', required: true, options: list('PAYMENT_STATUS'), defaultValue: 'Paid' },
    { name: 'assetId', label: 'Asset ID', type: 'text', placeholder: 'AST-001 (durables only)', help: 'Link a durable to 16_ASSETS.' },
    { name: 'usefulLifeMonths', label: 'Useful life (months)', type: 'number', min: 1, max: 600 },
    { name: 'warrantyExpiry', label: 'Warranty expires', type: 'date' },
  ];
}

export function cashflowFields(): FieldSpec[] {
  return [
    { name: 'date', label: 'Date', type: 'date', required: true, defaultValue: today() },
    { name: 'type', label: 'Type', type: 'select', required: true, options: list('CASH_TYPE') },
    { name: 'description', label: 'Description', type: 'textarea', required: true },
    { name: 'moneyIn', label: 'Money in', type: 'currency', help: 'Fill exactly one of money in / money out.' },
    { name: 'moneyOut', label: 'Money out', type: 'currency' },
    { name: 'refId', label: 'Reference', type: 'text', placeholder: 'BK-…, EXP-… (optional)' },
    { name: 'account', label: 'Account', type: 'text', placeholder: 'Primary Bank, Cash Box…' },
    { name: 'reconStatus', label: 'Reconciliation', type: 'select', required: true, options: list('RECON_STATUS'), defaultValue: 'Unreconciled' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

/* ------------------------------------------------------------------ *
 * Operations
 * ------------------------------------------------------------------ */

/**
 * Create a booking.
 *
 * `withValues` decides whether the money columns are offered at all. They are omitted on
 * the operations workspace: OPERATIONS holds no financial capability, and a role that may
 * not read a booking's value has no business authoring one. They remain on the finance
 * view of the same register, where money is entered.
 *
 * Nothing is hidden either way — an omitted field is not in the form, not in the payload
 * and not in the browser.
 */
export function reservationFields(
  propertyIds: readonly string[], platforms: readonly string[],
  { withValues = true }: { withValues?: boolean } = {},
): FieldSpec[] {
  const money: FieldSpec[] = withValues ? [
    { name: 'baseRate', label: 'Base rate / night', type: 'currency' },
    { name: 'roomRevenue', label: 'Room revenue', type: 'currency', help: 'Totals, fees and payouts are calculated by the workbook.' },
    { name: 'cleaningFee', label: 'Cleaning fee', type: 'currency' },
    { name: 'extraGuestFee', label: 'Extra guest fee', type: 'currency' },
    { name: 'discount', label: 'Discount', type: 'currency' },
  ] : [];
  return [
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, false) },
    { name: 'platform', label: 'Platform', type: 'select', required: true, options: platforms.map((value) => ({ value })) },
    { name: 'platformResId', label: 'Platform reference', type: 'text', placeholder: 'OTA reservation code (optional)' },
    { name: 'guestName', label: 'Guest name', type: 'text', required: true },
    { name: 'adults', label: 'Adults', type: 'number', required: true, min: 1, max: 20, defaultValue: '2' },
    { name: 'children', label: 'Children', type: 'number', min: 0, max: 20, defaultValue: '0' },
    { name: 'bookingDate', label: 'Booked on', type: 'date', required: true, defaultValue: today() },
    { name: 'checkInDate', label: 'Check-in', type: 'date', required: true },
    { name: 'checkOutDate', label: 'Check-out', type: 'date', required: true },
    { name: 'bookingStatus', label: 'Status', type: 'select', required: true, options: list('BOOKING_STATUS'), defaultValue: 'Confirmed' },
    ...money,
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function maintenanceFields(propertyIds: readonly string[]): FieldSpec[] {
  return [
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, true) },
    { name: 'dateReported', label: 'Reported on', type: 'date', required: true, defaultValue: today() },
    { name: 'issueCategory', label: 'Category', type: 'select', required: true, options: list('MAINT_CATEGORY') },
    { name: 'description', label: 'What is wrong?', type: 'textarea', required: true },
    { name: 'priority', label: 'Priority', type: 'select', required: true, options: list('MAINT_PRIORITY') },
    { name: 'estimatedCost', label: 'Estimated cost', type: 'currency' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function housekeepingFields(propertyIds: readonly string[]): FieldSpec[] {
  return [
    { name: 'propertyId', label: 'Property', type: 'select', required: true, options: propertyOptions(propertyIds, false) },
    { name: 'checkoutDate', label: 'Checkout date', type: 'date', required: true, defaultValue: today() },
    { name: 'bookingId', label: 'Booking ID', type: 'text', placeholder: 'BK-… (optional)' },
    { name: 'cleaner', label: 'Assigned to', type: 'text', placeholder: 'Leave blank to assign later' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function inventoryMovementFields(): FieldSpec[] {
  return [
    { name: 'purchased', label: 'Purchased (units)', type: 'number', min: 0, help: 'Cumulative purchased count for this item, as V1 records it.' },
    { name: 'used', label: 'Used (units)', type: 'number', min: 0 },
    { name: 'lastPurchaseDate', label: 'Last purchase date', type: 'date' },
    { name: 'lastPurchaseCost', label: 'Last purchase cost', type: 'currency' },
    { name: 'vendor', label: 'Vendor', type: 'text' },
    { name: 'minStock', label: 'Minimum stock', type: 'number', min: 0 },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function resolveMaintenanceFields(): FieldSpec[] {
  return [
    { name: 'dateResolved', label: 'Resolved on', type: 'date', required: true, defaultValue: today() },
    { name: 'actualCost', label: 'Actual cost', type: 'currency' },
    { name: 'vendor', label: 'Vendor', type: 'text' },
    { name: 'expenseId', label: 'Expense ID', type: 'text', placeholder: 'EXP-… if a bill was recorded' },
    { name: 'notes', label: 'Notes', type: 'textarea' },
  ];
}

export function cancelReservationFields(): FieldSpec[] {
  return [
    { name: 'reason', label: 'Why is this booking being cancelled?', type: 'textarea', required: true },
  ];
}

/**
 * A no-show is the same server transition as a cancellation with `noShow: true` — the
 * caller supplies that flag as a constant, so the form asks only for what a person
 * actually has to type. The row is never deleted; the status moves and the reason is
 * recorded, exactly as with a cancellation.
 */
export function noShowFields(): FieldSpec[] {
  return [
    {
      name: 'reason', label: 'What happened?', type: 'textarea', required: true,
      placeholder: 'Guest did not arrive and did not make contact',
      help: 'Recorded on the booking. The row stays in the ledger — a no-show is a status, not a deletion.',
    },
  ];
}

/**
 * Extend or shorten a stay: the departure date, and nothing else.
 *
 * No figure is asked for and none is offered. Changing the length of a stay changes
 * what the booking is worth, and the workbook owns that arithmetic — this records the
 * new date and the formulas follow. The server re-checks the date order against the
 * booking on file, so a departure cannot be moved before the arrival.
 */
export function extendStayFields(currentCheckOut: string | null): FieldSpec[] {
  return [
    {
      name: 'checkOutDate', label: 'New check-out date', type: 'date', required: true,
      ...(currentCheckOut ? { defaultValue: currentCheckOut } : {}),
      help: 'Totals and payout are recalculated by the workbook from the new dates.',
    },
  ];
}

/**
 * Amend a booking's own details. NON-FINANCIAL ONLY, and deliberately so.
 *
 * Every money column is absent — not hidden, absent — because this form is reached from
 * an operations surface and OPERATIONS holds no financial capability. `ActualPayout` and
 * `PayoutDate` are absent for the same reason and one more: the role that may not READ
 * the payout must not set it either.
 *
 * The guest name is offered BLANK rather than prefilled. The product never discloses a
 * full guest name, so prefilling it would mean writing back the minimised form
 * ("Priya S.") and destroying the real name on save. Left blank the field is simply not
 * sent, so an untouched form changes nothing.
 */
export function editBookingFields(current: {
  adults: number; children: number;
  checkIn: string | null; checkOut: string | null; notes: string | null;
}): FieldSpec[] {
  return [
    {
      name: 'guestName', label: 'Correct the guest name', type: 'text',
      placeholder: 'Leave blank to keep the current name',
      help: 'The full name is not shown here. Fill this in only to replace it.',
    },
    { name: 'adults', label: 'Adults', type: 'number', min: 1, max: 20, defaultValue: String(current.adults) },
    { name: 'children', label: 'Children', type: 'number', min: 0, max: 20, defaultValue: String(current.children) },
    {
      name: 'checkInDate', label: 'Check-in', type: 'date',
      ...(current.checkIn ? { defaultValue: current.checkIn } : {}),
    },
    {
      name: 'checkOutDate', label: 'Check-out', type: 'date',
      ...(current.checkOut ? { defaultValue: current.checkOut } : {}),
    },
    {
      name: 'notes', label: 'Notes', type: 'textarea',
      ...(current.notes ? { defaultValue: current.notes } : {}),
    },
  ];
}

/**
 * Check-in and check-out ask for one thing: the time it happened.
 *
 * Both are OPTIONAL, because the server's schemas make them optional and the workbook
 * carries no scheduled arrival time to check against — the time enters the system here
 * or not at all. Neither action collects payment, a deposit or any figure: no such rule
 * exists in this product, and inventing one on a front-office screen would be inventing
 * a commercial term.
 */
/**
 * ARRIVAL — what a front desk actually records while the guest is standing there.
 *
 * Every field is optional and every blank is left alone: the transition is the action,
 * and the rest is what happened to be observed. A half-filled arrival is a real arrival.
 *
 * `notes` is offered ONLY when the booking's current notes can be prefilled. The write
 * replaces the cell, so an empty box beside existing notes would quietly delete them the
 * first time somebody typed in it. Prefilled, the person edits what is already there —
 * the same shape `editBookingFields` uses for the same reason.
 *
 * NO MONEY, and no deposit: a deposit is a business decision this product has not been
 * given, and inventing a field for one would be inventing the decision.
 */
export function checkInFields(current?: { notes: string | null }): FieldSpec[] {
  return [
    {
      name: 'checkInTime', label: 'Arrival time', type: 'time',
      help: 'Recorded on the booking. Leave blank if nobody noted it.',
    },
    {
      name: 'guestVerification', label: 'ID checked?', type: 'select',
      options: list('VERIFY'),
      help: 'Whether identity was verified at the desk. No document is stored anywhere.',
    },
    {
      name: 'earlyCheckIn', label: 'Early arrival', type: 'boolean',
      help: 'Arrived before the standard time. Recorded as a fact — nothing is charged.',
    },
    ...notesField(current, 'Anything the next person on the desk should know.'),
  ];
}

/**
 * DEPARTURE — the two facts housekeeping and maintenance need, and the time it happened.
 *
 * `damageReport` is free text on the booking, not a claim and not a charge. Blank stays
 * blank: the detail panel renders an empty damage report as "Not recorded" rather than
 * as a clean bill, so an unasked question must not be answered here either.
 *
 * NO refund, NO deposit settlement, NO late-checkout fee. `lateCheckout` records that it
 * happened; what it costs is a business decision that has not been made.
 */
export function checkOutFields(current?: { notes: string | null }): FieldSpec[] {
  return [
    {
      name: 'checkOutTime', label: 'Departure time', type: 'time',
      help: 'Recorded on the booking. Leave blank if nobody noted it.',
    },
    {
      name: 'lateCheckout', label: 'Late departure', type: 'boolean',
      help: 'Left after the standard time. Recorded as a fact — nothing is charged.',
    },
    {
      name: 'damageReport', label: 'Damage found', type: 'textarea',
      placeholder: 'Leave blank if there is none to report',
      help: 'What the unit was left like. Blank means nobody has said — not that it is clear.',
    },
    {
      name: 'maintenanceRequired', label: 'Needs maintenance', type: 'boolean',
      help: 'Flags the booking. Raise the ticket itself on the Maintenance board.',
    },
    ...notesField(current, 'Anything housekeeping or the next guest should know.'),
  ];
}

/**
 * The booking's notes, editable — but only where the current value can be shown.
 *
 * Offering an empty box that OVERWRITES is how notes get lost; there is no append in the
 * write pipeline (`toColumns` sees the request, never the row), so the honest control is
 * one that starts from what is already recorded.
 */
function notesField(current: { notes: string | null } | undefined, help: string): FieldSpec[] {
  if (!current) return [];
  return [{
    name: 'notes', label: 'Notes', type: 'textarea', help,
    ...(current.notes ? { defaultValue: current.notes } : {}),
  }];
}

/**
 * FINISHING A TURNOVER — who cleaned it, how it inspected, and what state that leaves it in.
 *
 * `finalStatus` was missing, and its absence was the whole bug: the button said "Mark
 * clean", the toast said the unit was ready, and `housekeeping.update` wrote the cleaner
 * and the inspection while FinalStatus — the turnover's ONLY canonical state — stayed
 * Pending. The task never left the outstanding list and the unit was never ready.
 *
 * It is ASKED FOR rather than derived. A failed inspection and a completed turnover are
 * two different columns with two different vocabularies, and the workbook lets both be
 * set independently; inferring one from the other here would invent a rule the contract
 * does not have. The default is the ordinary outcome, and the person can say otherwise.
 */
export function markCleanFields(): FieldSpec[] {
  return [
    { name: 'cleaner', label: 'Cleaned by', type: 'text', required: true },
    {
      name: 'inspectionStatus', label: 'Inspection', type: 'select', required: true,
      options: list('INSPECTION'), defaultValue: 'Passed',
      help: 'The inspection result, recorded on the turnover.',
    },
    {
      name: 'finalStatus', label: 'Turnover now', type: 'select', required: true,
      options: list('HK_STATUS'), defaultValue: 'Completed',
      help: 'Completed takes the unit off the outstanding list. Choose otherwise if it is not finished.',
    },
  ];
}
