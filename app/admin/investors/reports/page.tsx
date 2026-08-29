import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, EmptyState, ConfigurationRequired } from '@/components/ui/primitives';
import { formatMonthLong } from '@/lib/shared/format';
import type { InvestorPreviewView } from '@/lib/data/providers/types';

export const metadata = { title: 'Investor Reports — Srivillu Home Stays' };

export default async function InvestorReportsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="investor"
      capability="reports.read"
      title="Investor reports"
      description="Statements released to investors. A period becomes releasable only after month-end close, so investors never see figures management has not finished reconciling."
      searchParams={params}
      filters={['month']}
      fetcher={(provider, f) => provider.getInvestorPreview(f)}
    >
      {(preview, envelope) => <ReportsList preview={preview} period={envelope.meta.period} />}
    </ReadOnlyPage>
  );
}

function ReportsList({ preview, period }: { preview: InvestorPreviewView; period: string }) {
  return (
    <>
      {!preview.configured ? (
        <>
          <ConfigurationRequired message={
            'Statements cannot be released while the distribution rules are unset — a statement showing ₹0 would misrepresent the position.'
          } />
          <div style={{ height: 'var(--space-4)' }} />
        </>
      ) : null}

      <Card>
        {/* No roadmap badge (§16): internal phase names are not client vocabulary. The
            empty state below already states the real condition for release. */}
        <CardHeader title={`Statements — ${formatMonthLong(period)}`} />
        <CardBody>
          <EmptyState
            title="No statements released for this period"
            message="Once the commercial rules are approved and the month is closed, generated statements will be listed here for release."
          />
        </CardBody>
      </Card>
    </>
  );
}
