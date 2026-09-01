import { redirect } from 'next/navigation';
import type { SearchParams } from '@/lib/shared/page-helpers';

/**
 * CHECK-INS — a filtered entry point into Today, not a second booking screen.
 *
 * This route rendered its own arrivals table with its own check-in button over the same
 * `getOperations` payload the Today board already reads. Two renderings of one row
 * concept drift: they disagreed about which day they were showing until the previous
 * commit, and they would have disagreed about something else next.
 *
 * Today is a strict superset — arrivals AND departures for a chosen day, the same
 * check-in and check-out mutations, a real day control, and a banner that says when the
 * live queues are not from the day being browsed. So the route stays (bookmarks and old
 * links keep working) and hands the reader to the screen that does the job.
 *
 * The day and the property travel with them: arriving on a redirect that silently
 * dropped `?date=` would be its own small lie.
 */
export default async function CheckinsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.date) query.set('date', params.date);
  if (params.property) query.set('property', params.property);
  const search = query.toString();
  redirect(search ? `/admin/operations/today?${search}` : '/admin/operations/today');
}
