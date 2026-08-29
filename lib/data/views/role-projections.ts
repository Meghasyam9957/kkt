/**
 * ROLE-SAFE VIEW PROJECTIONS — where register columns are decided per role.
 *
 * The provider returns full register rows, performance figures included, because one
 * business engine computes every view. Which COLUMNS a viewer may receive is a role
 * decision, and for the shared registers (/admin/properties, /admin/reservations, and the
 * operations reservations screen) this module is the only place that decision exists.
 *
 * The invariant, from lib/shared/roles.ts: OPERATIONS holds no financial capability, so a
 * financial field must never leave the server for that role. Hiding a column is not
 * enforcement — a value that reaches the render pass can reach the payload; a value that
 * was never projected cannot. Enforcement here is structural:
 *
 *   - Each operational row type declares every field it carries. The compile-time guards
 *     at the bottom refuse the build if a withheld field is ever added to one.
 *   - Each projection constructs a FRESH object literal, field by field. Never a spread:
 *     a spread would silently carry every future financial column along with it.
 *   - The operational tables in components/pages take the projected types, so rendering
 *     a financial field there is a type error, not a review comment.
 */
import type { PropertyBoardRow, ReservationRow, UnitStatus } from '@/lib/data/providers/types';

/* ------------------------------------------------------------------ *
 * Properties
 * ------------------------------------------------------------------ */

/**
 * The unit register as OPERATIONS sees it: identity, master detail and live state.
 * Occupancy stays — it is utilisation (nights occupied / nights available), carries no
 * rate or amount, and cannot be combined with anything this role holds to recover one.
 */
export interface OperationalPropertyRow {
  propertyId: string;
  unit: string;
  bhkType: string;
  floor: number;
  bedrooms: number;
  maxGuests: number;
  listingStatus: string;
  occupancyPct: number;
  status: UnitStatus;
  statusDetail: string | null;
}

/**
 * The financial fields of a property row, named so the ban is auditable. `satisfies`
 * pins each name to a real key of the full row type — rename a field there and this
 * list must follow, keeping the ban attached to the live field.
 */
export const PROPERTY_FIELDS_WITHHELD_FROM_OPERATIONS = [
  'netRevenue', 'directOperatingExpenses', 'profit', 'adr', 'revPar',
] as const satisfies readonly (keyof PropertyBoardRow)[];

export function operationalPropertyRows(
  rows: readonly PropertyBoardRow[],
): OperationalPropertyRow[] {
  return rows.map((row) => ({
    propertyId: row.propertyId,
    unit: row.unit,
    bhkType: row.bhkType,
    floor: row.floor,
    bedrooms: row.bedrooms,
    maxGuests: row.maxGuests,
    listingStatus: row.listingStatus,
    occupancyPct: row.occupancyPct,
    status: row.status,
    statusDetail: row.statusDetail,
  }));
}

/* ------------------------------------------------------------------ *
 * Reservations
 * ------------------------------------------------------------------ */

/**
 * A booking as the operational screens see it: who arrives where and when, and the
 * lifecycle state their actions depend on. Payout fields are withheld INCLUDING the
 * status — chasing money is finance work, and the operations reservations table has
 * always said so: "payouts and revenue live on the finance screens".
 */
export interface OperationalReservationRow {
  bookingId: string;
  platform: string;
  propertyId: string;
  bookingStatus: string;
  /** Already minimised upstream: given name + last initial, never contact details. */
  guestDisplayName: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
}

export const RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS = [
  'grossValue', 'expectedPayout', 'actualPayout', 'payoutStatus',
] as const satisfies readonly (keyof ReservationRow)[];

export function operationalReservationRows(
  rows: readonly ReservationRow[],
): OperationalReservationRow[] {
  return rows.map((row) => ({
    bookingId: row.bookingId,
    platform: row.platform,
    propertyId: row.propertyId,
    bookingStatus: row.bookingStatus,
    guestDisplayName: row.guestDisplayName,
    checkIn: row.checkIn,
    checkOut: row.checkOut,
    nights: row.nights,
  }));
}

/* ------------------------------------------------------------------ *
 * Compile-time guards
 * ------------------------------------------------------------------ */

/** `true` only when T carries no key from F. */
type Disjoint<T, F extends PropertyKey> = Extract<keyof T, F> extends never ? true : never;

/**
 * If a withheld field is ever added to an operational row type, these two lines are the
 * ones that refuse to compile. Exported so no lint rule ever "tidies" them away.
 */
export const OPERATIONAL_PROPERTY_ROW_CARRIES_NO_FINANCIAL_FIELD: Disjoint<
  OperationalPropertyRow, (typeof PROPERTY_FIELDS_WITHHELD_FROM_OPERATIONS)[number]
> = true;

export const OPERATIONAL_RESERVATION_ROW_CARRIES_NO_FINANCIAL_FIELD: Disjoint<
  OperationalReservationRow, (typeof RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS)[number]
> = true;
