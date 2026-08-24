import '@/lib/server/only';
/**
 * The workbook, for investor-scoped screens.
 *
 * `InvestorService` filters by the server-resolved investor id, so it needs the same
 * underlying records management sees. This helper obtains them from the active provider —
 * whichever environment and source that is — and returns the period to report on.
 *
 * It deliberately does not accept an investor id. Nothing here decides who is asking; that
 * is the session's job, and keeping the two apart is what makes the filter in
 * `InvestorService` the single place scoping happens.
 */
import type { DashboardDataProvider } from '@/lib/data/providers/types';
import type { WorkbookData } from '@/lib/shared/domain';
import { buildDemoDataset } from '@/lib/data/demo/dataset';
import { currentDataset } from '@/lib/server/demo/store';
import { resolveEnvironment } from '@/lib/server/environment/config';

export interface InvestorDataContext {
  workbook: WorkbookData;
  monthKey: string;
}

export async function loadWorkbookForInvestor(
  provider: DashboardDataProvider,
): Promise<InvestorDataContext> {
  const meta = await provider.getSourceMeta();
  const resolved = resolveEnvironment();

  // In demo the dataset is already in memory; reading it directly avoids rebuilding the
  // whole workbook for one screen. In production it comes from the provider's own source.
  const workbook = resolved.env === 'demo'
    ? currentDataset().workbook
    : (await provider.getMonthlySeries({ month: meta.period }), await loadFromProvider(provider));

  return { workbook, monthKey: meta.period };
}

/**
 * Production path.
 *
 * The provider does not expose raw records by design — every management screen reads a
 * view. Investor screens are the one place a filtered raw read is required, so it is
 * routed through the provider's own workbook rather than a second Sheets client.
 */
async function loadFromProvider(provider: DashboardDataProvider): Promise<WorkbookData> {
  const withWorkbook = provider as DashboardDataProvider & { workbookData?: () => Promise<WorkbookData> };
  if (typeof withWorkbook.workbookData === 'function') return withWorkbook.workbookData();
  // No live provider is configured to expose records yet; refuse rather than guess.
  throw new Error(
    'Investor screens require record-level access, which the configured data provider does not expose. ' +
    'This is wired for the demo dataset and for the Google Sheets provider from Phase 5.',
  );
}

export { buildDemoDataset };
