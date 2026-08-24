import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { GuestRequestsTable } from '@/components/pages/OpsTables';

export const metadata = { title: 'Guest Requests — Srivillu Home Stays' };

export default async function GuestRequestsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Guest Requests"
      description="What guests have asked for. The live workbook does not track these yet — a V1 sheet (or an approved store) is required before this screen can write."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => (
        <GuestRequestsTable
          rows={board.guestRequests}
          tracked={!board.counters.unavailable.includes('guestRequests')}
        />
      )}
    </ReadOnlyPage>
  );
}
