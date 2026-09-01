import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { ArrivalsTable } from '@/components/pages/OpsTables';

export const metadata = { title: 'Check-outs — MAKAM Home Stays' };

export default async function CheckoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Check-outs"
      /* Not "today's": this screen honours ?date=, so the header must not promise a day
         it has not read yet. The card below names the day the rows actually belong to. */
      description="Departures for the day being viewed. Checking a guest out hands the unit to housekeeping."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => (
        <ArrivalsTable
          rows={board.departures}
          mode="checkout"
          date={board.date}
          isOperationalDay={board.isOperationalDay}
        />
      )}
    </ReadOnlyPage>
  );
}
