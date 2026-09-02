import '@/lib/server/only';
/**
 * MUTATION SERVICES — one definition per mutation route, and the registrar that binds
 * them to the router. Definitions are DATA: schema, column mapping, referential checks.
 * Execution is always `executeMutation` (lib/server/api/mutations.ts) — no definition
 * can skip a layer because no other execution path exists.
 *
 * Business validation here CHECKS; it never computes. "check-out after check-in" is a
 * check. A payout figure would be a computation — and has no field to land in, because
 * `role: calc` columns are not addressable through this layer at all.
 */
import { columnIndex } from '@/lib/contract/contract.generated';
import type { Row } from '@/lib/server/sheets/client';
import { isoToSerial } from '@/lib/shared/dates';
import type { ApiRouter } from './router';
import {
  executeMutation, MutationError,
  type MutationDefinition, type MutationDependencies, type MutationContextData,
} from './mutations';
import * as S from './schemas';

/* ------------------------------------------------------------------ *
 * Shared referential checks
 * ------------------------------------------------------------------ */

async function propertyCheck(
  ctx: MutationContextData, key = 'propertyId', { allowCommon = true, mustBeActive = false } = {},
): Promise<string[]> {
  const id = String(ctx.input[key] ?? '');
  if (!id) return [];
  if (id === 'COMMON') {
    return allowCommon ? [] : [`${key}: COMMON is not a bookable unit.`];
  }
  const properties = await ctx.repos.properties.readAll();
  const match = properties.find((p) => p.PropertyID === id);
  if (!match) return [`${key}: no property "${id}" exists in 03_PROPERTIES.`];
  if (mustBeActive && match.PropertyStatus !== 'Available' && match.PropertyStatus !== 'Occupied') {
    return [`${key}: property "${id}" is ${match.PropertyStatus} and cannot take this record.`];
  }
  return [];
}

function dateOrder(input: Record<string, unknown>, fromKey: string, toKey: string): string[] {
  const from = input[fromKey]; const to = input[toKey];
  if (typeof from !== 'string' || typeof to !== 'string') return [];
  return isoToSerial(to) > isoToSerial(from)
    ? []
    : [`${toKey} must be after ${fromKey}.`];
}

/**
 * Check-in before check-out, on the MERGED row: whichever date the caller did not send
 * comes from the stored booking. Reads, never computes — the stored dates are serials
 * already, so nothing is converted twice.
 */
async function datesRemainOrdered(ctx: MutationContextData): Promise<string[]> {
  const bookings = await ctx.repos.reservations.readAll();
  const current = bookings.find((b) => b.BookingID === (ctx.entityId ?? ''));
  if (!current) return [];   // the transition check already reports an unknown booking

  const checkIn = ctx.input.checkInDate !== undefined
    ? isoToSerial(String(ctx.input.checkInDate)) : current.CheckInDate;
  const checkOut = ctx.input.checkOutDate !== undefined
    ? isoToSerial(String(ctx.input.checkOutDate)) : current.CheckOutDate;

  if (checkIn === null || checkOut === null) return [];
  return checkOut > checkIn
    ? []
    : ['checkOutDate must be after checkInDate.'];
}

async function reservationTransition(
  ctx: MutationContextData, next: string,
): Promise<string[]> {
  const id = ctx.entityId ?? '';
  const bookings = await ctx.repos.reservations.readAll();
  const current = bookings.find((b) => b.BookingID === id);
  if (!current) return [`No booking "${id}" exists in 04_RESERVATIONS.`];
  const allowed = S.RESERVATION_TRANSITIONS[current.BookingStatus] ?? [];
  return allowed.includes(next)
    ? []
    : [`A booking in status "${current.BookingStatus}" cannot move to "${next}".`];
}

/* ------------------------------------------------------------------ *
 * Definitions
 * ------------------------------------------------------------------ */

const defs: Record<string, MutationDefinition> = {

  /* ---- Reservations ---- */
  'reservation.create': {
    action: 'reservation.create', sheet: 'RESERVATIONS', kind: 'create',
    schema: S.ReservationCreate, idKey: 'BookingID', allocatesId: true,
    dateColumns: ['BookingDate', 'CheckInDate', 'CheckOutDate'],
    validate: async (ctx) => [
      ...await propertyCheck(ctx, 'propertyId', { allowCommon: false, mustBeActive: true }),
      ...dateOrder(ctx.input, 'checkInDate', 'checkOutDate'),
      ...await (async () => {
        const settings = await ctx.repos.settings.read();
        const names = Object.keys(settings.platformCommission);
        return names.includes(String(ctx.input.platform))
          ? [] : [`platform: "${ctx.input.platform}" is not a configured platform (${names.join(', ')}).`];
      })(),
      ...await (async () => {
        const properties = await ctx.repos.properties.readAll();
        const unit = properties.find((p) => p.PropertyID === ctx.input.propertyId);
        const guests = Number(ctx.input.adults ?? 0) + Number(ctx.input.children ?? 0);
        return unit && guests > unit.MaxGuests
          ? [`guests: ${guests} exceeds ${unit.PropertyID}'s maximum of ${unit.MaxGuests}.`] : [];
      })(),
    ],
    toColumns: (i, id) => ({
      BookingID: id, Platform: i.platform, PlatformResID: i.platformResId,
      PropertyID: i.propertyId, BookingDate: i.bookingDate, BookingStatus: i.bookingStatus,
      GuestName: i.guestName, Adults: i.adults, Children: i.children,
      CheckInDate: i.checkInDate, CheckOutDate: i.checkOutDate,
      BaseRate: i.baseRate, RoomRevenue: i.roomRevenue, CleaningFee: i.cleaningFee,
      ExtraGuestFee: i.extraGuestFee, OtherCharges: i.otherCharges, Discount: i.discount,
      Notes: i.notes,
    }),
  },
  'reservation.update': {
    action: 'reservation.update', sheet: 'RESERVATIONS', kind: 'update',
    schema: S.ReservationUpdate, idKey: 'BookingID',
    dateColumns: ['CheckInDate', 'CheckOutDate', 'PayoutDate'],
    validate: async (ctx) => {
      const problems: string[] = [];
      if (ctx.input.bookingStatus !== undefined) {
        problems.push(...await reservationTransition(ctx, String(ctx.input.bookingStatus)));
      }
      /*
       * "Check-out must be after check-in" was only checked when BOTH dates arrived in
       * the same request, so amending ONE of them skipped it entirely — an extend-stay
       * that moved the departure before the arrival was accepted. That was unreachable
       * while no screen offered a single-date change; the booking detail now does.
       *
       * This is the same rule, not a new one: it is evaluated against the row as it will
       * be AFTER the patch, filling whichever date the request did not supply from the
       * booking already on file.
       */
      if (ctx.input.checkInDate !== undefined || ctx.input.checkOutDate !== undefined) {
        problems.push(...await datesRemainOrdered(ctx));
      }
      return problems;
    },
    toColumns: (i) => ({
      BookingStatus: i.bookingStatus, GuestName: i.guestName,
      Adults: i.adults, Children: i.children,
      CheckInDate: i.checkInDate, CheckOutDate: i.checkOutDate,
      ActualPayout: i.actualPayout, PayoutDate: i.payoutDate, Notes: i.notes,
    }),
  },
  'reservation.checkIn': {
    action: 'reservation.checkIn', sheet: 'RESERVATIONS', kind: 'update',
    schema: S.ReservationCheckIn, idKey: 'BookingID',
    validate: (ctx) => reservationTransition(ctx, 'Checked In'),
    /* The transition, plus what the front desk observed while the guest stood there.
       Undefined keys are stripped before the write, so a field nobody filled in leaves
       the workbook's own cell exactly as it was. */
    toColumns: (i) => ({
      BookingStatus: 'Checked In',
      CheckInTime: i.checkInTime,
      GuestVerification: i.guestVerification,
      EarlyCheckIn: i.earlyCheckIn,
      Notes: i.notes,
    }),
  },
  'reservation.checkOut': {
    action: 'reservation.checkOut', sheet: 'RESERVATIONS', kind: 'update',
    schema: S.ReservationCheckOut, idKey: 'BookingID',
    validate: (ctx) => reservationTransition(ctx, 'Checked Out'),
    /* Departure records what the unit was left like — the two facts housekeeping and
       maintenance need. No charge is computed for a late checkout and no deposit is
       settled: those are business decisions, and neither has been made. */
    toColumns: (i) => ({
      BookingStatus: 'Checked Out',
      CheckOutTime: i.checkOutTime,
      LateCheckout: i.lateCheckout,
      DamageReport: i.damageReport,
      MaintenanceRequired: i.maintenanceRequired,
      Notes: i.notes,
    }),
  },
  'reservation.cancel': {
    action: 'reservation.cancel', sheet: 'RESERVATIONS', kind: 'update',
    schema: S.ReservationCancel, idKey: 'BookingID',
    validate: async (ctx) =>
      reservationTransition(ctx, ctx.input.noShow ? 'No Show' : 'Cancelled'),
    // A cancellation is a status transition plus a reason in Notes — the row remains.
    // The note names what actually happened: a no-show recorded as "Cancelled via web"
    // reads, months later, as a decision somebody made rather than a guest who never came.
    toColumns: (i) => ({
      BookingStatus: i.noShow ? 'No Show' : 'Cancelled',
      Notes: `${i.noShow ? 'No-show' : 'Cancelled'} via web: ${i.reason}`,
    }),
  },

  /* ---- Finance ---- */
  'revenue.create': {
    action: 'revenue.create', sheet: 'REVENUE', kind: 'create',
    schema: S.RevenueCreate, idKey: 'RevenueID', allocatesId: true,
    dateColumns: ['Date', 'PayoutDate'],
    validate: async (ctx) => {
      const problems = await propertyCheck(ctx);
      if (ctx.input.bookingId) {
        const bookings = await ctx.repos.reservations.readAll();
        if (!bookings.some((b) => b.BookingID === ctx.input.bookingId)) {
          problems.push(`bookingId: no booking "${ctx.input.bookingId}" exists.`);
        }
      }
      return problems;
    },
    toColumns: (i, id) => ({
      RevenueID: id, BookingID: i.bookingId, PropertyID: i.propertyId, Date: i.date,
      RevenueType: i.revenueType, Platform: i.platform, GrossAmount: i.grossAmount,
      PayoutStatus: i.payoutStatus, PayoutDate: i.payoutDate,
      PaymentAccount: i.paymentAccount, Notes: i.notes,
    }),
  },
  'revenue.update': {
    action: 'revenue.update', sheet: 'REVENUE', kind: 'update',
    schema: S.RevenueUpdate, idKey: 'RevenueID', dateColumns: ['PayoutDate'],
    toColumns: (i) => ({
      PayoutStatus: i.payoutStatus, PayoutDate: i.payoutDate,
      PaymentAccount: i.paymentAccount, Notes: i.notes,
    }),
  },
  'expense.create': {
    action: 'expense.create', sheet: 'EXPENSES', kind: 'create',
    schema: S.ExpenseCreate, idKey: 'ExpenseID', allocatesId: true,
    dateColumns: ['Date', 'PaidDate'],
    validate: (ctx) => propertyCheck(ctx),
    toColumns: (i, id) => ({
      ExpenseID: id, Date: i.date, PropertyID: i.propertyId,
      ExpenseCategory: i.expenseCategory, ExpenseSubcategory: i.expenseSubcategory,
      Description: i.description, Vendor: i.vendor, Amount: i.amount, Tax: i.tax,
      PaymentMethod: i.paymentMethod, PaymentStatus: i.paymentStatus, PaidDate: i.paidDate,
      Recurring: i.recurring, ExpenseType: i.expenseType,
    }),
  },
  'expense.update': {
    action: 'expense.update', sheet: 'EXPENSES', kind: 'update',
    schema: S.ExpenseUpdate, idKey: 'ExpenseID', dateColumns: ['PaidDate'],
    toColumns: (i) => ({
      PaymentStatus: i.paymentStatus, PaidDate: i.paidDate,
      Vendor: i.vendor, Description: i.description,
    }),
  },
  'capex.create': {
    action: 'capex.create', sheet: 'CAPEX', kind: 'create',
    schema: S.CapexCreate, idKey: 'CapexID', allocatesId: true,
    dateColumns: ['Date', 'WarrantyExpiry'],
    validate: (ctx) => propertyCheck(ctx),
    toColumns: (i, id) => ({
      CapexID: id, PropertyID: i.propertyId, Date: i.date, Category: i.category,
      Item: i.item, Quantity: i.quantity, UnitCost: i.unitCost, Vendor: i.vendor,
      PaymentStatus: i.paymentStatus, AssetID: i.assetId,
      UsefulLifeMonths: i.usefulLifeMonths, WarrantyExpiry: i.warrantyExpiry,
    }),
  },
  'capex.update': {
    action: 'capex.update', sheet: 'CAPEX', kind: 'update',
    schema: S.CapexUpdate, idKey: 'CapexID',
    toColumns: (i) => ({ PaymentStatus: i.paymentStatus, Vendor: i.vendor, AssetID: i.assetId }),
  },
  'rent.update': {
    action: 'rent.update', sheet: 'RENT', kind: 'update',
    schema: S.RentUpdate, idKey: 'RecordID', dateColumns: ['LastPaidDate', 'PaidForMonth'],
    toColumns: (i) => ({
      LastPaidDate: i.lastPaidDate, PaidForMonth: i.paidForMonth, Notes: i.notes,
    }),
  },
  'cashflow.create': {
    action: 'cashflow.create', sheet: 'CASHFLOW', kind: 'create',
    schema: S.CashflowCreate, idKey: 'TxnID', allocatesId: true, dateColumns: ['Date'],
    validate: async (ctx) => {
      // Mirrors the workbook's own QA rule as a CHECK (the rule already exists there —
      // this simply refuses to create a row the QA sheet would immediately flag).
      const moneyIn = Number(ctx.input.moneyIn ?? 0);
      const moneyOut = Number(ctx.input.moneyOut ?? 0);
      if ((moneyIn > 0) === (moneyOut > 0)) {
        return ['Exactly one of moneyIn / moneyOut must be greater than zero.'];
      }
      return [];
    },
    toColumns: (i, id) => ({
      TxnID: id, Date: i.date, Type: i.type, RefID: i.refId, Description: i.description,
      MoneyIn: i.moneyIn, MoneyOut: i.moneyOut, Account: i.account,
      ReconStatus: i.reconStatus, Notes: i.notes,
    }),
  },
  'cashflow.update': {
    action: 'cashflow.update', sheet: 'CASHFLOW', kind: 'update',
    schema: S.CashflowUpdate, idKey: 'TxnID',
    toColumns: (i) => ({ ReconStatus: i.reconStatus, Notes: i.notes }),
  },

  /* ---- Operations board ---- */
  'housekeeping.create': {
    action: 'housekeeping.create', sheet: 'HOUSEKEEPING', kind: 'create',
    schema: S.HousekeepingCreate, idKey: 'TaskID', allocatesId: true,
    dateColumns: ['CheckoutDate', 'AssignedDate'],
    validate: (ctx) => propertyCheck(ctx, 'propertyId', { allowCommon: false }),
    toColumns: (i, id) => ({
      TaskID: id, BookingID: i.bookingId, PropertyID: i.propertyId,
      CheckoutDate: i.checkoutDate, AssignedDate: i.checkoutDate,
      Cleaner: i.cleaner,
      // Same rule as maintenance: a turnover starts life needing doing.
      FinalStatus: i.cleaner ? 'Assigned' : 'Pending',
      Notes: i.notes,
    }),
  },
  'housekeeping.update': {
    action: 'housekeeping.update', sheet: 'HOUSEKEEPING', kind: 'update',
    schema: S.HousekeepingUpdate, idKey: 'TaskID',
    toColumns: (i) => ({
      Cleaner: i.cleaner, InspectionStatus: i.inspectionStatus, FinalStatus: i.finalStatus,
      LinenChanged: i.linenChanged, ToiletriesRestocked: i.toiletriesRestocked,
      KitchenChecked: i.kitchenChecked, DamageChecked: i.damageChecked, Notes: i.notes,
    }),
  },
  'maintenance.create': {
    action: 'maintenance.create', sheet: 'MAINTENANCE', kind: 'create',
    schema: S.MaintenanceCreate, idKey: 'TicketID', allocatesId: true,
    dateColumns: ['DateReported'],
    validate: (ctx) => propertyCheck(ctx),
    toColumns: (i, id) => ({
      TicketID: id, DateReported: i.dateReported, PropertyID: i.propertyId,
      IssueCategory: i.issueCategory, Description: i.description, Priority: i.priority,
      // A ticket is born needing someone. A blank status would drop it from every
      // open-ticket filter — invisible on the board it was created to appear on.
      Status: 'Open',
      EstimatedCost: i.estimatedCost, Notes: i.notes,
    }),
  },
  'maintenance.update': {
    action: 'maintenance.update', sheet: 'MAINTENANCE', kind: 'update',
    schema: S.MaintenanceUpdate, idKey: 'TicketID', dateColumns: ['DateResolved'],
    validate: async (ctx) => {
      // Resolving requires a resolution date — otherwise DowntimeDays can never settle.
      if ((ctx.input.status === 'Resolved' || ctx.input.status === 'Closed')
        && ctx.input.dateResolved === undefined) {
        return ['dateResolved is required when a ticket is Resolved or Closed.'];
      }
      return [];
    },
    toColumns: (i) => ({
      Status: i.status, Priority: i.priority, AssignedTo: i.assignedTo,
      DateResolved: i.dateResolved, ActualCost: i.actualCost,
      ExpenseID: i.expenseId, Vendor: i.vendor, Notes: i.notes,
    }),
  },
  'inventory.update': {
    action: 'inventory.update', sheet: 'INVENTORY', kind: 'update',
    schema: S.InventoryUpdate, idKey: 'ItemID', dateColumns: ['LastPurchaseDate'],
    toColumns: (i) => ({
      Purchased: i.purchased, Used: i.used, MinStock: i.minStock,
      LastPurchaseDate: i.lastPurchaseDate, LastPurchaseCost: i.lastPurchaseCost,
      Vendor: i.vendor, Notes: i.notes,
    }),
  },

  /* ---- Management registers ---- */
  'investor.create': {
    action: 'investor.create', sheet: 'INVESTORS', kind: 'create',
    schema: S.InvestorCreate, idKey: 'InvestorID', allocatesId: true,
    dateColumns: ['InvestmentDate'],
    toColumns: (i, id) => ({
      InvestorID: id, InvestorName: i.investorName, InvestmentAmount: i.investmentAmount,
      InvestmentDate: i.investmentDate, ParticipationPct: i.participationPct,
      Status: i.status, AgreementRef: i.agreementRef, Contact: i.contact, Notes: i.notes,
    }),
  },
  'investor.update': {
    action: 'investor.update', sheet: 'INVESTORS', kind: 'update',
    schema: S.InvestorUpdate, idKey: 'InvestorID',
    toColumns: (i) => ({
      Status: i.status, AgreementRef: i.agreementRef, Contact: i.contact, Notes: i.notes,
    }),
  },
  'distribution.update': {
    action: 'distribution.update', sheet: 'DIST', kind: 'update',
    schema: S.DistributionUpdate, idKey: 'InvestorID', dateColumns: ['PaidDate'],
    // DIST rows are keyed by (InvestorID, Period) — the ID column alone matches every
    // period. `where` narrows to the requested period's row.
    where: (input) => {
      const periodSerial = isoToSerial(String(input.period));
      const periodIdx = columnIndex('DIST', 'Period');
      return (row: Row) => Number(row[periodIdx]) === periodSerial;
    },
    toColumns: (i) => ({
      PaidAmount: i.paidAmount, PaidDate: i.paidDate,
      PaymentRef: i.paymentRef, Notes: i.notes,
    }),
  },
  'property.create': {
    action: 'property.create', sheet: 'PROPERTIES', kind: 'create',
    schema: S.PropertyCreate, idKey: 'PropertyID',
    // No ID rule exists for properties: identifiers are human-assigned (HYD-xxx),
    // validated for format by the schema and for uniqueness here.
    validate: async (ctx) => {
      const properties = await ctx.repos.properties.readAll();
      return properties.some((p) => p.PropertyID === ctx.input.propertyId)
        ? [`propertyId: "${ctx.input.propertyId}" already exists.`] : [];
    },
    toColumns: (i) => ({
      PropertyID: i.propertyId, Unit: i.unit, BHKType: i.bhkType,
      MaxGuests: i.maxGuests, PropertyStatus: i.propertyStatus, ListingStatus: i.listingStatus,
    }),
  },
  'property.update': {
    action: 'property.update', sheet: 'PROPERTIES', kind: 'update',
    schema: S.PropertyUpdate, idKey: 'PropertyID',
    toColumns: (i) => ({
      Unit: i.unit, MaxGuests: i.maxGuests,
      PropertyStatus: i.propertyStatus, ListingStatus: i.listingStatus,
    }),
  },
};

export const MUTATION_DEFINITIONS: Readonly<Record<string, MutationDefinition>> = defs;

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export interface MutationRouteBinding {
  method: 'POST' | 'PATCH';
  path: string;
  action: string;
}

/** Route → definition, from the registry itself so the two can never drift. */
export function registerMutationHandlers(
  router: ApiRouter,
  routes: ReadonlyArray<{ method: string; path: string; action: string; mutates?: boolean }>,
  deps: MutationDependencies,
): void {
  for (const route of routes) {
    if (!route.mutates) continue;
    const def = defs[route.action];
    if (!def) {
      throw new Error(`Mutation route ${route.method} ${route.path} has no definition for ${route.action}`);
    }
    router.register(route.method as 'POST' | 'PATCH', route.path, async (ctx) => {
      try {
        return await executeMutation(def, ctx, deps);
      } catch (error) {
        if (error instanceof MutationError) {
          // The router's guard wraps handlers; a typed refusal becomes a typed response.
          return {
            __mutationError: true,
            status: error.status, code: error.code,
            message: error.message, details: error.details,
          };
        }
        throw error;
      }
    });
  }

  /*
   * Operation-status polling: own operations only.
   *
   * Two independent checks, and both are server-resolved. The ACTOR must match, so one
   * colleague cannot poll another's operation; and the TENANT must match, so the day a
   * support principal holds memberships in two customers, the same user id polling the
   * same operation id does not cross between them. An id in the path names WHICH
   * operation, never WHOSE.
   */
  router.register('GET', '/api/operations-log/:id', async (ctx) => {
    const id = ctx.request.params?.id ?? '';
    const record = await deps.store.get(id);
    const sameTenant = !!record && !!ctx.auth.tenantId && record.tenantId === ctx.auth.tenantId;
    if (!record || !sameTenant || record.actorId !== (ctx.auth.userId ?? null)) {
      // The same answer for "not yours" and "does not exist": no probe oracle.
      return { __mutationError: true, status: 404, code: 'NOT_FOUND', message: 'No such operation.' };
    }
    return {
      operationId: record.operationId, status: record.status,
      action: record.action, entityId: record.entityId ?? null,
      error: record.error ?? null,
    };
  });
}
