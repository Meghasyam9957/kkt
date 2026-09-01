import '@/lib/server/only';
/**
 * DEMO WORKBOOK GRIDS — the demo dataset expressed as sheet grids.
 *
 * Purpose: a demo deployment with NO configured Google workbook must still run the
 * REAL mutation pipeline — same repositories, same verified writes, same read-after-
 * write — against the `InMemorySheetsClient`. This module lays the deterministic demo
 * dataset out as grids in the V1 contract's own column order, so every write lands and
 * verifies exactly as it would against Google.
 *
 * Domain records already use the contract's column keys as field names (that is how the
 * repositories map rows), so laying them out is mechanical: input columns are written,
 * calc columns are left null — in a fixtures demo nothing recalculates them, and the
 * pipeline neither writes nor verifies calc cells.
 */
import {
  COLUMNS, DATA_ROW, SHEET_META, inputColumns, type SheetKey,
} from '@/lib/contract/contract.generated';
import type { Row } from '@/lib/server/sheets/client';
import { InMemorySheetsClient } from '@/lib/server/sheets/client';
import { isoToSerial } from '@/lib/shared/dates';
import { currentDataset } from './store';

type AnyRecords = ReadonlyArray<Record<string, unknown>>;

const ENTITY_SHEETS: ReadonlyArray<{ sheet: SheetKey; records: (d: ReturnType<typeof currentDataset>) => AnyRecords }> = [
  { sheet: 'PROPERTIES', records: (d) => d.workbook.properties as unknown as AnyRecords },
  { sheet: 'RESERVATIONS', records: (d) => d.workbook.reservations as unknown as AnyRecords },
  { sheet: 'REVENUE', records: (d) => d.workbook.revenue as unknown as AnyRecords },
  { sheet: 'EXPENSES', records: (d) => d.workbook.expenses as unknown as AnyRecords },
  { sheet: 'CAPEX', records: (d) => d.workbook.capex as unknown as AnyRecords },
  { sheet: 'CASHFLOW', records: (d) => d.workbook.cashflow as unknown as AnyRecords },
  { sheet: 'INVESTORS', records: (d) => d.workbook.investors as unknown as AnyRecords },
  { sheet: 'DIST', records: (d) => d.workbook.distributions as unknown as AnyRecords },
  {
    sheet: 'RENT',
    // RentRecord is the one domain shape with camelCase fields (it was ported from the
    // V1 rent engine, not read through a repository map) — translate to column keys.
    records: (d) => (d.registers.rent as unknown as ReadonlyArray<Record<string, unknown>>).map((r) => ({
      RecordID: r.recordId, PropertyID: r.propertyId, CostType: r.costType,
      LandlordVendor: r.landlordVendor, MonthlyAmount: r.monthlyAmount, DueDay: r.dueDay,
      AgreementStart: r.agreementStart, AgreementEnd: r.agreementEnd,
      EscalationPct: r.escalationPct, LastPaidDate: r.lastPaidDate, PaidForMonth: r.paidForMonth,
    })),
  },
];

/** Rows 1..DATA_ROW-1 are banner/legend/header in V1; blank fillers keep addressing true. */
const HEADER_FILLER: Row[] = Array.from({ length: DATA_ROW - 1 }, () => [] as Row);

export function buildDemoWorkbookGrids(): Record<string, Row[]> {
  const dataset = currentDataset();
  const grids: Record<string, Row[]> = {};

  for (const { sheet, records } of ENTITY_SHEETS) {
    const cols = COLUMNS[sheet] ?? [];
    const writable = new Set(inputColumns(sheet).map((c) => c.key));
    const rows: Row[] = records(dataset).map((record) =>
      cols.map((col) => {
        if (!writable.has(col.key)) return null;              // calc cells stay workbook-owned
        const value = (record as Record<string, unknown>)[col.key];
        return value === undefined || value === null ? null : (value as Row[number]);
      }));
    grids[SHEET_META[sheet].name] = [...HEADER_FILLER, ...rows];
  }

  /*
   * Operational sheets, seeded from the demo ops board so the register pages and the
   * write path share one store. The ops records are view-shaped (camelCase, some
   * workbook-calculated fields precomputed by the dataset builder) — translated to
   * column keys here. Seeding a fixture's CALC cell (Inventory CurrentStock) is
   * legitimate: the dataset invented that fictional value in the first place, and the
   * WRITE pipeline still cannot touch calc cells — this is constructor seeding, below
   * the client's write guards.
   */
  const ops = dataset.ops;
  grids[SHEET_META.HOUSEKEEPING.name] = [
    ...HEADER_FILLER,
    ...ops.housekeeping.map((t) => layRow('HOUSEKEEPING', {
      TaskID: t.taskId, PropertyID: t.propertyId,
      CheckoutDate: t.checkoutDate ? isoToSerial(t.checkoutDate) : null,
      FinalStatus: t.status,
      // Written so the grid-backed demo reads back what the dataset says. BookingID is
      // not laid at all: the dataset holds none, and an empty cell is the truth.
      InspectionStatus: t.inspectionStatus, Cleaner: t.cleaner,
    })),
  ];
  grids[SHEET_META.MAINTENANCE.name] = [
    ...HEADER_FILLER,
    ...ops.maintenance.map((t) => layRow('MAINTENANCE', {
      TicketID: t.ticketId, PropertyID: t.propertyId, IssueCategory: t.category,
      Description: t.description, Priority: t.priority, Status: t.status,
      DateReported: t.reportedOn ? isoToSerial(t.reportedOn) : null,
    })),
  ];
  grids[SHEET_META.INVENTORY.name] = [
    ...HEADER_FILLER,
    ...ops.inventory.map((i) => layRow('INVENTORY', {
      ItemID: i.itemId, PropertyID: i.propertyId, Item: i.item, Unit: i.unit,
      // Fictional inputs consistent with the dataset's own stock figure.
      OpeningStock: i.currentStock, Purchased: 0, Used: 0,
      MinStock: i.minStock,
    }, { CurrentStock: i.currentStock })),
  ];

  return grids;
}

/** Lay one row in a sheet's column order: inputs from `values`, plus explicitly seeded
 *  calc cells (fixture seeding only — the write path can never reach these). */
function layRow(
  sheet: SheetKey,
  values: Record<string, unknown>,
  calcSeed: Record<string, unknown> = {},
): Row {
  const writable = new Set(inputColumns(sheet).map((c) => c.key));
  return (COLUMNS[sheet] ?? []).map((col) => {
    const source = writable.has(col.key) ? values[col.key] : calcSeed[col.key];
    return source === undefined || source === null ? null : (source as Row[number]);
  });
}

/** Grids plus named ranges, as one seed — what the shared demo store applies. */
export function buildDemoSeed(): {
  grids: Record<string, Row[]>;
  named: Array<[string, Row[]]>;
} {
  const dataset = currentDataset();
  const s = dataset.workbook.settings;
  const scalars: ReadonlyArray<readonly [string, Row[number]]> = [
    ['CFG_BIZ_NAME', s.businessName], ['CFG_CITY', s.city], ['CFG_COUNTRY', s.country],
    ['CFG_CURRENCY', s.currency], ['CFG_FY_START', s.fyStart],
    ['CFG_INVESTOR_POOL_PCT', s.investorPoolPct], ['CFG_OPERATOR_POOL_PCT', s.operatorPoolPct],
    ['CFG_RESERVE_PCT', s.reservePct], ['CFG_MGMT_FEE_PCT', s.mgmtFeePct],
    ['CFG_LOSS_TREATMENT', s.lossTreatment], ['CFG_PROFIT_DEFINITION', s.profitDefinition],
    ['CFG_PAYOUT_TOLERANCE', s.payoutToleranceInr], ['CFG_PAYOUT_OVERDUE_DAYS', s.payoutOverdueDays],
    ['CFG_RENT_DUE_DAYS', s.rentDueDays],
  ];
  const named: Array<[string, Row[]]> = scalars.map(([name, value]) => [name, [[value ?? null]]]);
  named.push(['TBL_PLATFORMS', Object.entries(s.platformCommission).map(([name, commission]) => [
    name, commission, s.platformPayoutLagDays[name] ?? 0,
  ])]);
  return { grids: buildDemoWorkbookGrids(), named };
}

/**
 * A ready client: grids plus the named ranges `SettingsRepository` reads. Settings
 * values come from the demo dataset's own BusinessSettings, so the pipeline's
 * referential checks (configured platforms, tolerances) agree with what the demo
 * provider shows on screen.
 */
export function buildDemoSheetsClient(): InMemorySheetsClient {
  const dataset = currentDataset();
  const client = new InMemorySheetsClient(buildDemoWorkbookGrids());
  const s = dataset.workbook.settings;

  /*
   * PROJECTION, not assignment: every value here comes from the demo dataset's OWN
   * BusinessSettings — no commercial figure is invented in this file (the security
   * suite's business-rule scan stays authoritative for that). Tuples rather than object
   * keys so the projection cannot be mistaken for a constant assignment.
   */
  const named: ReadonlyArray<readonly [string, Row[number]]> = [
    ['CFG_BIZ_NAME', s.businessName], ['CFG_CITY', s.city], ['CFG_COUNTRY', s.country],
    ['CFG_CURRENCY', s.currency], ['CFG_FY_START', s.fyStart],
    ['CFG_INVESTOR_POOL_PCT', s.investorPoolPct], ['CFG_OPERATOR_POOL_PCT', s.operatorPoolPct],
    ['CFG_RESERVE_PCT', s.reservePct], ['CFG_MGMT_FEE_PCT', s.mgmtFeePct],
    ['CFG_LOSS_TREATMENT', s.lossTreatment], ['CFG_PROFIT_DEFINITION', s.profitDefinition],
    ['CFG_PAYOUT_TOLERANCE', s.payoutToleranceInr], ['CFG_PAYOUT_OVERDUE_DAYS', s.payoutOverdueDays],
    ['CFG_RENT_DUE_DAYS', s.rentDueDays],
  ];
  for (const [name, value] of named) {
    client.setNamedRange(name, [[value ?? null]]);
  }
  client.setNamedRange('TBL_PLATFORMS', Object.entries(s.platformCommission).map(([name, commission]) => [
    name, commission, s.platformPayoutLagDays[name] ?? 0,
  ]));

  return client;
}
