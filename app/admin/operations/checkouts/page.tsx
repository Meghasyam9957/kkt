import { redirect } from 'next/navigation';
import type { SearchParams } from '@/lib/shared/page-helpers';

/**
 * CHECK-OUTS — the other half of the same day, and the same reasoning as `../checkins`.
 *
 * Today shows departures beside arrivals with the identical check-out mutation, so this
 * route is an entry point rather than an implementation. It keeps working for anyone who
 * bookmarked it, and carries the day and the property across.
 */
export default async function CheckoutsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const query = new URLSearchParams();
  if (params.date) query.set('date', params.date);
  if (params.property) query.set('property', params.property);
  const search = query.toString();
  redirect(search ? `/admin/operations/today?${search}` : '/admin/operations/today');
}
