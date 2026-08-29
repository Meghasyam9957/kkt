/**
 * TODAY — the front-office command desk.
 *
 * Built for someone standing at a desk with a guest in front of them: what day is this,
 * what is happening, what needs a person, and the action to take, on the row itself.
 *
 * **No financial figure appears on this screen.** The operations role holds no financial
 * capability, and a board that shows money beside a cleaning task both leaks it and pulls
 * attention to the wrong decision.
 *
 * Every record comes from the data provider — the same one every other screen uses — and
 * every action runs the existing verified write path, then re-reads. Nothing on this page
 * computes a booking state of its own.
 */
import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { TodayBoard } from '@/components/operations/TodayBoard';

export const metadata = { title: "Today — Srivillu Home Stays" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Today"
      description="Arrivals, departures and turnovers, with the next step on each line."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, filters) => provider.getOperations(filters)}
    >
      {(board) => <TodayBoard board={board} />}
    </ReadOnlyPage>
  );
}
