/**
 * DATA PROVIDER CONTRACT.
 *
 * Page components depend on this interface and never on a fixture or on the Sheets
 * adapter. Phase 4 ships `FixtureDashboardDataProvider`; Phase 5 adds
 * `GoogleSheetsDashboardDataProvider`. Because both run the SAME KPI engine, swapping
 * them changes where rows come from — not what any number means.
 *
 * Every payload carries `meta`, so the UI can state its provenance and freshness rather
 * than implying the figures are live.
 */
import type {
  MonthlyMetrics, PropertyPerformance, PlatformPerformance, InvestorWaterfall,
  InvestorAllocation,
} from '@/lib/shared/domain';

export type DataSourceKind = 'FIXTURE' | 'GOOGLE_SHEETS';
export type FreshnessState = 'GOOD' | 'STALE' | 'ERROR';

export interface DataMeta {
  /** Where these numbers came from. Drives the DEMO DATA badge. */
  source: DataSourceKind;
  /** ISO timestamp the underlying data was read. */
  asOf: string;
  /** The reporting period the figures describe, e.g. '2027-01'. */
  period: string;
  freshness: FreshnessState;
  /** True while LIVE_DATA_ENABLED is false — the UI must say so, unmistakably. */
  demo: boolean;
  /**
   * When the source was last read SUCCESSFULLY. Distinct from `asOf` in one case that
   * matters: after a failed refresh the payload is the last good data, `asOf` is when
   * that data was fetched, and the UI must present it as stale rather than as current.
   * Null means no successful read has happened at all.
   */
  lastSuccessfulSyncAt?: string | null;
  /** Age of the payload in seconds at the moment it was served. */
  ageSeconds?: number;
  /** Whether this payload came from the read cache, and how. */
  cache?: 'HIT' | 'MISS' | 'REFRESH';
  /**
   * Set when the most recent fetch failed. Its presence is what stops the UI calling the
   * data live: stale-with-an-error is a state the operator must be able to see.
   */
  error?: string | null;
}

export interface Envelope<T> {
  data: T;
  meta: DataMeta;
}

/** The filter set. Session/client state only — it never writes to the workbook. */
export interface ReportFilters {
  /** 'YYYY-MM'. */
  month: string;
  /** Property ID, or null for all. */
  propertyId?: string | null;
  /** Platform name, or null for all. */
  platform?: string | null;
}

/* ------------------------------------------------------------------ *
 * View models — shaped for the screen, computed on the server side
 * ------------------------------------------------------------------ */

export type KpiFormat = 'currency' | 'percent' | 'number' | 'nights';

export interface KpiValue {
  key: string;
  label: string;
  value: number;
  format: KpiFormat;
  /** Previous comparable period, when one exists. */
  previousValue?: number | null;
  /** Fractional change vs the previous period; null when there is nothing to compare. */
  changeRatio?: number | null;
  /** Whether an increase is good — margin up is good, expenses up is not. */
  higherIsBetter?: boolean;
  hint?: string;
  /**
   * Set when the figure cannot honestly be shown as a number: unset business rules, or
   * not enough history. The UI must render this state, never a plausible-looking zero.
   */
  unavailable?: { reason: 'CONFIGURATION_REQUIRED' | 'INSUFFICIENT_DATA'; message: string };
}

export type UnitStatus = 'Occupied' | 'Available' | 'Cleaning' | 'Maintenance' | 'Blocked';

/** A property row for the status board: performance plus its live operational state. */
export interface PropertyBoardRow extends PropertyPerformance {
  bhkType: string;
  floor: number;
  bedrooms: number;
  maxGuests: number;
  listingStatus: string;
  status: UnitStatus;
  /** Short human explanation of the status, e.g. 'AC not cooling'. */
  statusDetail: string | null;
}

export interface OperationsToday {
  date: string;
  checkIns: number;
  checkOuts: number;
  pendingCleaning: number;
  openMaintenance: number;
  lowStock: number;
  guestRequests: number;
  /**
   * Counter keys this data source cannot supply — e.g. guest requests have no V1 sheet,
   * so a live read has nothing to count. The UI shows "not tracked" for these instead of
   * a zero, which would read as "nothing outstanding".
   */
  unavailable: string[];
}

/* ------------------------------------------------------------------ *
 * Operations board — action first, figures never
 * ------------------------------------------------------------------ */

export type UrgentSeverity = 'critical' | 'high' | 'watch';

/**
 * One thing that needs a person today, in the words they would use about it.
 *
 * Ordered by severity so the board opens with what matters. No amount, no rate and no
 * margin appears here: an operations screen that shows money invites the wrong decision
 * and hands financial detail to a role that is not entitled to it.
 */
export interface UrgentItem {
  key: string;
  severity: UrgentSeverity;
  propertyId: string;
  /** What has happened. */
  title: string;
  /** What someone should do about it. */
  action: string;
  reference: string;
}

export interface ArrivalRow {
  bookingId: string;
  propertyId: string;
  /** Given name + last initial. An operations list never needs more. */
  guestDisplayName: string;
  nights: number;
  guests: number;
  platform: string;
  status: string;
}

export interface CleaningRow {
  taskId: string;
  propertyId: string;
  checkoutDate: string;
  status: string;
}

export interface MaintenanceRow {
  ticketId: string;
  propertyId: string;
  category: string;
  description: string;
  priority: string;
  status: string;
  reportedOn: string;
  ageDays: number;
}

export interface StockRow {
  itemId: string;
  propertyId: string;
  item: string;
  unit: string;
  currentStock: number;
  minStock: number;
  state: 'Out of stock' | 'Low' | 'In stock';
}

export interface GuestRequestRow {
  requestId: string;
  propertyId: string;
  summary: string;
  raisedOn: string;
  status: string;
}

export interface OperationsBoardView {
  date: string;
  counters: OperationsToday;
  urgent: UrgentItem[];
  arrivals: ArrivalRow[];
  departures: ArrivalRow[];
  cleaning: CleaningRow[];
  maintenance: MaintenanceRow[];
  lowStock: StockRow[];
  /** The full stock register (every item, with its state) — the inventory screen. */
  stock: StockRow[];
  guestRequests: GuestRequestRow[];
  /** Unit status, without any financial column. */
  units: Array<{ propertyId: string; unit: string; status: UnitStatus; statusDetail: string | null }>;
}

/** The investor master, for management eyes. Investors never see this list. */
export interface InvestorRegisterRow {
  investorId: string;
  investorName: string;
  investmentAmount: number;
  participationPct: number;
  status: string;
}

export interface TrendPoint {
  month: string;
  label: string;
  netRevenue: number;
  operatingExpenses: number;
  operatingProfit: number;
  occupancyPct: number;
  adr: number;
  revPar: number;
}

export interface DashboardView {
  kpis: KpiValue[];
  properties: PropertyBoardRow[];
  platforms: PlatformPerformance[];
  today: OperationsToday;
  trend: TrendPoint[];
  /** Months that carry data, for the period picker. */
  availableMonths: string[];
}

export interface ReservationRow {
  bookingId: string;
  platform: string;
  propertyId: string;
  bookingStatus: string;
  /** Minimised for list views: given name + last initial. Never contact details. */
  guestDisplayName: string;
  checkIn: string | null;
  checkOut: string | null;
  nights: number;
  grossValue: number;
  expectedPayout: number;
  actualPayout: number;
  payoutStatus: string;
}

export interface CapexRow {
  id: string;
  date: string | null;
  propertyId: string;
  category: string;
  item: string;
  quantity: number;
  unitCost: number;
  /** The V1 line rule (qty 0 counts as one unit), computed by the shared engine. */
  lineTotal: number;
  status: string;
}

export interface LedgerRow {
  id: string;
  date: string | null;
  propertyId: string;
  category: string;
  subCategory?: string;
  platform?: string;
  gross: number;
  deductions: number;
  net: number;
  status: string;
}

export interface PnlLine {
  key: string;
  label: string;
  values: number[];
  total: number;
  emphasis?: 'section' | 'subtotal' | 'total';
  isPercent?: boolean;
  memo?: boolean;
}

export interface PnlView {
  months: string[];
  monthLabels: string[];
  lines: PnlLine[];
}

export interface CashFlowRow {
  txnId: string;
  date: string | null;
  type: string;
  propertyId: string;
  moneyIn: number;
  moneyOut: number;
  runningBalance: number;
  reconStatus: string;
}

export interface SettingsView {
  businessName: string;
  city: string;
  country: string;
  currency: string;
  fyStart: string;
  platforms: Array<{ name: string; commissionPct: number | null; payoutLagDays: number }>;
  businessRules: Array<{
    name: string; label: string; value: string;
    configured: boolean; recordedOnly: boolean;
  }>;
}

export interface InvestorPreviewView {
  waterfall: InvestorWaterfall;
  allocations: InvestorAllocation[];
  /** False while the commercial rules are TBD; the UI must show CONFIGURATION REQUIRED. */
  configured: boolean;
  configurationMessage: string;
}

/* ------------------------------------------------------------------ *
 * The provider
 * ------------------------------------------------------------------ */

export interface DashboardDataProvider {
  readonly kind: DataSourceKind;
  getDashboard(filters: ReportFilters): Promise<Envelope<DashboardView>>;
  /** Performance PLUS the unit's master detail and live status. */
  getProperties(filters: ReportFilters): Promise<Envelope<PropertyBoardRow[]>>;
  /** The operations board: actions, tickets, stock and requests. No financial figures. */
  getOperations(filters: ReportFilters): Promise<Envelope<OperationsBoardView>>;
  /** The investor master. Management only — enforced by the route and the page guard. */
  getInvestorRegister(): Promise<Envelope<InvestorRegisterRow[]>>;
  getReservations(filters: ReportFilters): Promise<Envelope<ReservationRow[]>>;
  getRevenue(filters: ReportFilters): Promise<Envelope<LedgerRow[]>>;
  getExpenses(filters: ReportFilters): Promise<Envelope<LedgerRow[]>>;
  getCapex(filters: ReportFilters): Promise<Envelope<CapexRow[]>>;
  getCashFlow(filters: ReportFilters): Promise<Envelope<CashFlowRow[]>>;
  getPnl(filters: ReportFilters): Promise<Envelope<PnlView>>;
  getMonthlySeries(filters: ReportFilters): Promise<Envelope<MonthlyMetrics[]>>;
  getInvestorPreview(filters: ReportFilters): Promise<Envelope<InvestorPreviewView>>;
  getSettings(): Promise<Envelope<SettingsView>>;
  getAvailableMonths(): Promise<string[]>;
  getPlatforms(): Promise<string[]>;
  /** Property IDs for the filter bar. Comes from the source, never from a fixture list. */
  getPropertyIds(): Promise<string[]>;
  /**
   * Provenance and freshness for the app shell, without fetching a view. Must never
   * throw: the header has to be able to say "source unavailable" rather than taking the
   * whole shell down with it.
   */
  getSourceMeta(): Promise<DataMeta>;
  /**
   * Perform a real read of the source, replacing anything cached. Optional: a fixture has
   * nothing to refresh.
   */
  refresh?(): Promise<void>;
}
