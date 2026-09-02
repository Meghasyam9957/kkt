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

export interface InvestorDataContext {
  workbook: WorkbookData;
  monthKey: string;
}

export async function loadWorkbookForInvestor(
  provider: DashboardDataProvider,
): Promise<InvestorDataContext> {
  const meta = await provider.getSourceMeta();

  /*
   * THROUGH THE PROVIDER, in every environment.
   *
   * This used to branch: demo read `currentDataset().workbook` directly, which meant a
   * tenant-scoped provider was obtained by the caller and then thrown away — the only
   * place in the application where that happened. It read the same records in practice,
   * because the demonstration dataset is process-global; but it was a data path with no
   * tenant on it, sitting behind a call site that looked scoped. The demo provider now
   * exposes its own records, so there is one path and it is the tenant's.
   */
  const workbook = await loadFromProvider(provider);

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
