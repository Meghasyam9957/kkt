import '@/lib/server/only';
/**
 * GRID-BACKED DEMO PROVIDER — reads from the SAME in-memory workbook the mutation
 * pipeline writes to, so a demonstrated write is immediately visible on every screen.
 *
 * Mechanics: on each read it checks the shared demo store's version (seed identity +
 * write count). When the version moves, it reloads records through the SAME loaders the
 * live Google provider uses (`loadWorkbookData` / `loadOperationsData` /
 * `loadRentRegister`) and hands them to a fresh `FixtureDashboardDataProvider` — the
 * KPI engine then recomputes every figure from records, exactly as it does against a
 * real workbook. No view logic is duplicated and no figure is computed here.
 *
 * Guest requests have no V1 sheet, so they remain dataset-served — the one deliberate
 * asymmetry, already labelled "not tracked" on the live path.
 */
import { FixtureDashboardDataProvider } from './fixture-provider';
import type {
  DashboardDataProvider, Envelope, ReportFilters, DataMeta, AvailabilityQuery,
} from './types';
import {
  loadWorkbookData, loadOperationsData, loadRentRegister,
} from '@/lib/server/sheets/repositories';
import { getSharedDemoClient, demoStoreVersion } from '@/lib/server/demo/live-store';
import { currentDataset } from '@/lib/server/demo/store';

export class DemoGridProvider implements DashboardDataProvider {
  readonly kind = 'FIXTURE' as const;
  private inner: FixtureDashboardDataProvider | null = null;
  private version: string | null = null;
  private loading: Promise<FixtureDashboardDataProvider> | null = null;

  private async ensure(): Promise<FixtureDashboardDataProvider> {
    const version = demoStoreVersion();
    if (this.inner && this.version === version) return this.inner;
    if (!this.loading) {
      this.loading = this.rebuild(version).finally(() => { this.loading = null; });
    }
    return this.loading;
  }

  private async rebuild(version: string): Promise<FixtureDashboardDataProvider> {
    const client = getSharedDemoClient();
    const dataset = currentDataset();
    const [workbook, ops, rent] = await Promise.all([
      loadWorkbookData(client),
      loadOperationsData(client, dataset.ops.today),
      loadRentRegister(client),
    ]);
    // Guest requests live only in the demo dataset (no V1 sheet exists for them).
    ops.guestRequests = dataset.ops.guestRequests;
    ops.unavailableCounters = dataset.ops.unavailableCounters.filter((k) => k !== 'guestRequests');

    this.inner = new FixtureDashboardDataProvider({ workbook, ops, rent });
    this.version = version;
    return this.inner;
  }

  /* Delegation — every provider method goes through ensure() so no read can ever see
   * a pre-write snapshot after a verified write. */
  async getDashboard(f: ReportFilters) { return (await this.ensure()).getDashboard(f); }
  async getProperties(f: ReportFilters) { return (await this.ensure()).getProperties(f); }
  async getOperations(f: ReportFilters) { return (await this.ensure()).getOperations(f); }
  async getInvestorRegister() { return (await this.ensure()).getInvestorRegister(); }
  async getReservations(f: ReportFilters) { return (await this.ensure()).getReservations(f); }
  async getBookingDetail(id: string) { return (await this.ensure()).getBookingDetail(id); }
  async getCalendar(f: ReportFilters) { return (await this.ensure()).getCalendar(f); }
  async getAvailability(q: AvailabilityQuery) { return (await this.ensure()).getAvailability(q); }
  async getRevenue(f: ReportFilters) { return (await this.ensure()).getRevenue(f); }
  async getExpenses(f: ReportFilters) { return (await this.ensure()).getExpenses(f); }
  async getCapex(f: ReportFilters) { return (await this.ensure()).getCapex(f); }
  async getCashFlow(f: ReportFilters) { return (await this.ensure()).getCashFlow(f); }
  async getPnl(f: ReportFilters) { return (await this.ensure()).getPnl(f); }
  async getMonthlySeries(f: ReportFilters) { return (await this.ensure()).getMonthlySeries(f); }
  async getForecast(f: ReportFilters) { return (await this.ensure()).getForecast(f); }
  async getInvestorPreview(f: ReportFilters) { return (await this.ensure()).getInvestorPreview(f); }
  async getSettings() { return (await this.ensure()).getSettings(); }
  async getAvailableMonths() { return (await this.ensure()).getAvailableMonths(); }
  async getPlatforms() { return (await this.ensure()).getPlatforms(); }
  async getPropertyIds() { return (await this.ensure()).getPropertyIds(); }
  async getPropertyDirectory() { return (await this.ensure()).getPropertyDirectory(); }
  async getSourceMeta(): Promise<DataMeta> { return (await this.ensure()).getSourceMeta(); }
}

/** Type re-export convenience for the provider index. */
export type { Envelope };
