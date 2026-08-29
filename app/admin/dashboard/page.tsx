import { Suspense } from 'react';
import { getDataProvider } from '@/lib/data/providers';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { DemoAssumptionsNotice } from '@/components/demo/DemoAssumptionsNotice';
import { PageHeader, Section, LoadingBlock, ErrorState } from '@/components/ui/primitives';
import { FilterBar } from '@/components/shell/FilterBar';
import { DashboardContent } from '@/components/dashboard/DashboardView';
import { formatMonthLong } from '@/lib/shared/format';

export const metadata = { title: 'Dashboard — Srivillu Home Stays' };

export default async function DashboardPage({
  searchParams,
}: { searchParams: Promise<{ month?: string; property?: string; platform?: string }> }) {
  // The financial dashboard is management-only. Checked before a single figure is read.
  const access = await checkPageAccess('dashboard.financial.view');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  const params = await searchParams;
  const provider = getDataProvider();
  const months = await provider.getAvailableMonths();
  const month = params.month && months.includes(params.month)
    ? params.month
    : months[months.length - 1] ?? '';

  let content: React.ReactNode;
  let period = month;
  try {
    // One request for the KPI picture plus one for the attention list — the same reads
    // the shell and operations screens make, so nothing here is a per-card fetch.
    const filters = {
      month,
      propertyId: params.property ?? null,
      platform: params.platform ?? null,
    };
    const [{ data, meta }, ops] = await Promise.all([
      provider.getDashboard(filters),
      // Attention degrades to an empty list rather than failing the dashboard — but
      // never silently: the reason lands in the server log, and the operations screen
      // still surfaces its own error state.
      provider.getOperations(filters).catch((error: unknown) => {
        console.error('[dashboard] operations board unavailable:', error);
        return null;
      }),
    ]);
    period = meta.period;
    content = <DashboardContent view={data} meta={meta} urgent={ops?.data?.urgent ?? []} />;
  } catch (error) {
    /*
     * Same rule as ReadOnlyPage: the person sees a human sentence, the diagnostic goes to
     * the server log. Interpolating Error.message here printed connector strings, sheet
     * ranges and missing env-var names onto the first screen after sign-in.
     */
    console.error('[page] Dashboard failed to load:', error);
    content = (
      <ErrorState message="We couldn't load this screen's data. Try again in a moment, or contact the administrator if this continues." />
    );
  }

  return (
    <>
      <PageHeader
        title="Dashboard"
        description={`Operating position for ${formatMonthLong(period)}.`}
      />
      <Section>
        <DemoAssumptionsNotice scope="financial" />
      </Section>
      <Section>
        <Suspense fallback={<LoadingBlock rows={2} label="Loading filters" />}>
          <FilterBar />
        </Suspense>
      </Section>
      {content}
    </>
  );
}
