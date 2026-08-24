/**
 * Seed an `InMemorySheetsClient` with real domain data, laid out exactly as the contract
 * says the workbook lays it out.
 *
 * This exists so the live provider can be exercised end-to-end — repositories, column
 * indexes, named ranges and all — without a Google account. The point is that the ONLY
 * difference from production is where the bytes come from: the same repository code
 * parses the same column positions, so a mis-mapped column fails here too.
 */
import { InMemorySheetsClient, type Row } from '@/lib/server/sheets/client';
import { SHEETS, COLUMNS, DATA_ROW, DIST } from '@/lib/contract/contract.generated';
import { isoToSerial } from '@/lib/shared/dates';
import type { WorkbookData, OperationsData } from '@/lib/shared/domain';

type AnyRecord = Record<string, unknown>;

/** Blank grid with the contract's header row, ready for data at DATA_ROW. */
function emptyGrid(sheetKey: string, rows: number): Row[] {
  const cols = COLUMNS[sheetKey as keyof typeof COLUMNS] ?? [];
  const header = cols.map((c) => c.header);
  const blank = () => Array(cols.length).fill(null) as Row;
  const grid: Row[] = [];
  for (let i = 0; i < DATA_ROW - 2; i++) grid.push(blank());
  grid[DATA_ROW - 2] = header as Row;
  for (let i = 0; i < rows; i++) grid.push(blank());
  return grid;
}

/**
 * Write records whose property names ARE the contract column keys. That is true of every
 * financial sheet, which is why the repositories can be so mechanical.
 */
function writeByKey(client: InMemorySheetsClient, sheetKey: string, records: AnyRecord[]): void {
  const cols = COLUMNS[sheetKey as keyof typeof COLUMNS] ?? [];
  const grid = emptyGrid(sheetKey, records.length + 5);
  records.forEach((record, i) => {
    grid[DATA_ROW - 1 + i] = cols.map((c) => (record[c.key] ?? null) as Row[number]);
  });
  client.setSheet((SHEETS as Record<string, string>)[sheetKey]!, grid);
}

/** Ops sheets use camelCase domain names, so their mapping is written out explicitly. */
function writeMapped(
  client: InMemorySheetsClient,
  sheetKey: string,
  records: AnyRecord[],
  map: (record: AnyRecord) => Record<string, unknown>,
): void {
  writeByKey(client, sheetKey, records.map(map));
}

const serialOrNull = (iso: string | null | undefined) => (iso ? isoToSerial(iso) : null);

export function seedSheetsClient(
  workbook: WorkbookData,
  ops?: OperationsData,
): InMemorySheetsClient {
  const client = new InMemorySheetsClient();

  // Every sheet exists, even the ones with no data — a live workbook has all 22 tabs.
  for (const sheetKey of Object.keys(COLUMNS)) client.setSheet(
    (SHEETS as Record<string, string>)[sheetKey]!, emptyGrid(sheetKey, 5));

  writeByKey(client, 'PROPERTIES', workbook.properties as unknown as AnyRecord[]);
  writeByKey(client, 'RESERVATIONS', workbook.reservations as unknown as AnyRecord[]);
  writeByKey(client, 'REVENUE', workbook.revenue as unknown as AnyRecord[]);
  writeByKey(client, 'EXPENSES', workbook.expenses as unknown as AnyRecord[]);
  writeByKey(client, 'CAPEX', workbook.capex as unknown as AnyRecord[]);
  writeByKey(client, 'CASHFLOW', workbook.cashflow as unknown as AnyRecord[]);
  writeByKey(client, 'INVESTORS', workbook.investors as unknown as AnyRecord[]);

  // 12_INVESTOR_DISTRIBUTIONS puts its allocation table below the waterfall block, so the
  // rows start at the contract's own first table row rather than at DATA_ROW.
  {
    const cols = COLUMNS.DIST ?? [];
    const grid: Row[] = [];
    for (let i = 0; i < DIST.table.firstRow - 1; i++) grid.push(Array(cols.length).fill(null) as Row);
    workbook.distributions.forEach((record, i) => {
      grid[DIST.table.firstRow - 1 + i] =
        cols.map((c) => ((record as unknown as AnyRecord)[c.key] ?? null) as Row[number]);
    });
    client.setSheet(SHEETS.DIST, grid);
  }

  if (ops) {
    writeMapped(client, 'HOUSEKEEPING', ops.housekeeping as unknown as AnyRecord[], (t) => ({
      TaskID: t.taskId,
      PropertyID: t.propertyId,
      CheckoutDate: serialOrNull(t.checkoutDate as string),
      FinalStatus: t.status,
    }));
    writeMapped(client, 'MAINTENANCE', ops.maintenance as unknown as AnyRecord[], (t) => ({
      TicketID: t.ticketId,
      DateReported: serialOrNull(t.reportedOn as string),
      PropertyID: t.propertyId,
      IssueCategory: t.category,
      Description: t.description,
      Priority: t.priority,
      Status: t.status,
    }));
    writeMapped(client, 'INVENTORY', ops.inventory as unknown as AnyRecord[], (i) => ({
      ItemID: i.itemId,
      PropertyID: i.propertyId,
      Item: i.item,
      Unit: i.unit,
      CurrentStock: i.currentStock,
      MinStock: i.minStock,
    }));
  }

  /* Named ranges. The live API resolves these server-side; the settings repository reads
     them by name, so the fixture backend has to provide them the same way. */
  const s = workbook.settings;
  const named: Record<string, unknown> = {
    CFG_BIZ_NAME: s.businessName,
    CFG_CITY: s.city,
    CFG_COUNTRY: s.country,
    CFG_CURRENCY: s.currency,
    CFG_FY_START: s.fyStart,
    CFG_INVESTOR_POOL_PCT: s.investorPoolPct,
    CFG_OPERATOR_POOL_PCT: s.operatorPoolPct,
    CFG_RESERVE_PCT: s.reservePct,
    CFG_MGMT_FEE_PCT: s.mgmtFeePct,
    CFG_LOSS_TREATMENT: s.lossTreatment,
    CFG_PROFIT_DEFINITION: s.profitDefinition,
    CFG_PAYOUT_TOLERANCE: s.payoutToleranceInr,
    CFG_PAYOUT_OVERDUE_DAYS: s.payoutOverdueDays,
  };
  for (const [name, value] of Object.entries(named)) {
    client.setNamedRange(name, [[(value ?? null) as Row[number]]]);
  }
  client.setNamedRange('TBL_PLATFORMS', Object.keys(s.platformCommission).map((name) => [
    name,
    (s.platformCommission[name] ?? null) as Row[number],
    (s.platformPayoutLagDays[name] ?? 0) as Row[number],
  ]));

  return client;
}
