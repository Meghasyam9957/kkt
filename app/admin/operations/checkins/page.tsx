import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { ArrivalsTable } from '@/components/pages/OpsTables';

export const metadata = { title: 'Check-ins — MAKAM Home Stays' };

export default async function CheckinsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Check-ins"
      /* The page header cannot name the day — it renders before the board is fetched —
         so it stays honest about that instead of claiming "today". The card below
         carries the actual date. */
      description="Arrivals for the day being viewed, ready to check in as guests reach the door."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => (
        <ArrivalsTable
          rows={board.arrivals}
          mode="checkin"
          date={board.date}
          isOperationalDay={board.isOperationalDay}
        />
      )}
    </ReadOnlyPage>
  );
}
