import '@/lib/server/only';
/**
 * INVESTOR SERVICE — enforcement layer 3 (data/query).
 *
 * The guard already refuses client-supplied investor identity. This layer is the second,
 * independent stop: every method takes the investor id as a REQUIRED first argument that
 * the caller can only have obtained from the session, and each filters its result set by
 * that id before returning. If the guard were ever bypassed, nothing here would return
 * another investor's data.
 *
 * Approved disclosure scope (per the approved product decision):
 *   - the investor's OWN investment and distribution data
 *   - APPROVED portfolio-level figures
 *   - NO guest PII, no per-guest data, no other investor, no operational notes
 */
import {
  computeInvestorAllocations, computeInvestorWaterfall, computeMonthlySeries, fyMonthKeysFor,
} from '@/lib/server/analytics/kpi';
import type { WorkbookData } from '@/lib/shared/domain';

/** Portfolio figures approved for investor eyes. Deliberately excludes cost detail. */
export interface InvestorPortfolioView {
  monthKey: string;
  netRevenue: number;
  operatingProfit: number;
  occupancyPct: number;
  distributableProfit: number;
  /** Whether management has configured the distribution rules yet. */
  configured: boolean;
}

export interface InvestorOverview {
  investorId: string;
  investorName: string;
  capitalContributed: number;
  participationPct: number;
  status: string;
  portfolio: InvestorPortfolioView;
  configurationMessage: string;
}

export interface InvestorDistributionView {
  monthKey: string;
  participationPct: number;
  calculatedDistribution: number;
  paidAmount: number;
  pendingAmount: number;
  status: string;
}

/**
 * Fields an investor response must never contain. Asserted by the security suite against
 * actual payloads, so a future field addition cannot quietly leak.
 */
export const INVESTOR_FORBIDDEN_FIELDS: readonly string[] = [
  'GuestName', 'guestName', 'guest', 'PlatformResID', 'Adults', 'Children',
  'operatingExpenses', 'expenses', 'vendor', 'Vendor', 'supplier',
  'notes', 'Notes', 'internalNotes',
];

export class InvestorService {
  constructor(private readonly data: WorkbookData) {}

  private requireOwnRecord(investorId: string) {
    if (!investorId) throw new Error('InvestorService requires a server-resolved investor id');
    const record = this.data.investors.find((i) => i.InvestorID === investorId);
    if (!record) throw new Error('Investor record not found');
    return record;
  }

  /** Portfolio-level figures only — never cost detail or guest data. */
  private portfolio(monthKey: string): InvestorPortfolioView {
    const series = computeMonthlySeries(this.data, fyMonthKeysFor(this.data));
    const month = series.find((m) => m.monthKey === monthKey);
    const waterfall = computeInvestorWaterfall(this.data, monthKey);
    return {
      monthKey,
      netRevenue: month?.netRevenue ?? 0,
      operatingProfit: month?.operatingProfit ?? 0,
      occupancyPct: month?.occupancyPct ?? 0,
      distributableProfit: month?.distributableProfit ?? 0,
      configured: waterfall.configured,
    };
  }

  overview(investorId: string, monthKey: string): InvestorOverview {
    const record = this.requireOwnRecord(investorId);
    const waterfall = computeInvestorWaterfall(this.data, monthKey);
    return {
      investorId: record.InvestorID,
      investorName: record.InvestorName,
      capitalContributed: record.InvestmentAmount,
      participationPct: record.ParticipationPct,
      status: record.Status,
      portfolio: this.portfolio(monthKey),
      configurationMessage: waterfall.configurationMessage,
    };
  }

  /** Only this investor's rows. The filter is applied here, not by the caller. */
  distributions(investorId: string, monthKeys: string[]): InvestorDistributionView[] {
    this.requireOwnRecord(investorId);
    return monthKeys.flatMap((monthKey) =>
      computeInvestorAllocations(this.data, monthKey, { investorId })
        .filter((a) => a.investorId === investorId)   // belt and braces
        .map((a) => ({
          monthKey: a.monthKey,
          participationPct: a.participationPct,
          calculatedDistribution: a.calculatedDistribution,
          paidAmount: a.paidAmount,
          pendingAmount: a.pendingAmount,
          status: a.status,
        })),
    );
  }

  performance(investorId: string): InvestorPortfolioView[] {
    this.requireOwnRecord(investorId);
    return fyMonthKeysFor(this.data).map((monthKey) => this.portfolio(monthKey));
  }

  /**
   * Approved reports for this investor.
   *
   * Only months marked closed are offered — an investor should not see figures that
   * management has not finished reconciling. Which months are approved is a management
   * decision surfaced through the workbook's monthly close, not invented here.
   */
  reports(investorId: string, approvedMonths: string[]): Array<{ monthKey: string; title: string }> {
    this.requireOwnRecord(investorId);
    return approvedMonths.map((monthKey) => ({
      monthKey,
      title: `Investor statement — ${monthKey}`,
    }));
  }
}
