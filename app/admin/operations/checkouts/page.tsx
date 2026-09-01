import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { ArrivalsTable } from '@/components/pages/OpsTables';

export const metadata = { title: 'Check-outs — MAKAM Home Stays' };

export default async function CheckoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Check-outs"
      description="Today's departures. Checking a guest out hands the unit to housekeeping."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => <ArrivalsTable rows={board.departures} mode="checkout" />}
    </ReadOnlyPage>
  );
}
