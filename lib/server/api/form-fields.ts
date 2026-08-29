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

export function reservationFields(propertyIds: readonly string[], platforms: readonly string[]): FieldSpec[] {
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
    { name: 'baseRate', label: 'Base rate / night', type: 'currency' },
    { name: 'roomRevenue', label: 'Room revenue', type: 'currency', help: 'Totals, fees and payouts are calculated by the workbook.' },
    { name: 'cleaningFee', label: 'Cleaning fee', type: 'currency' },
    { name: 'extraGuestFee', label: 'Extra guest fee', type: 'currency' },
    { name: 'discount', label: 'Discount', type: 'currency' },
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
 * Check-in and check-out ask for one thing: the time it happened.
 *
 * Both are OPTIONAL, because the server's schemas make them optional and the workbook
 * carries no scheduled arrival time to check against — the time enters the system here
 * or not at all. Neither action collects payment, a deposit or any figure: no such rule
 * exists in this product, and inventing one on a front-office screen would be inventing
 * a commercial term.
 */
export function checkInFields(): FieldSpec[] {
  return [
    {
      name: 'checkInTime', label: 'Arrival time', type: 'time',
      help: 'Optional. Leave blank if it is not being recorded.',
    },
  ];
}

export function checkOutFields(): FieldSpec[] {
  return [
    {
      name: 'checkOutTime', label: 'Departure time', type: 'time',
      help: 'Optional. Leave blank if it is not being recorded.',
    },
  ];
}

export function markCleanFields(): FieldSpec[] {
  return [
    { name: 'cleaner', label: 'Cleaned by', type: 'text', required: true },
    { name: 'inspectionStatus', label: 'Inspection', type: 'select', required: true, options: list('INSPECTION'), defaultValue: 'Passed' },
  ];
}
