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
 * Since M-OPS-2 the desk also answers "who is working": the staffing section below the
 * board names who is on today, on what shift, and how many open tasks each person holds.
 * It carries no pay figure — see `components/operations/TodayStaffing.tsx`.
 *
 * Every record comes from the data provider — the same one every other screen uses — and
 * every action runs the existing verified write path, then re-reads. Nothing on this page
 * computes a booking state of its own.
 */
import { Suspense } from 'react';
import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { TodayBoard } from '@/components/operations/TodayBoard';
import { TodayStaffing } from '@/components/operations/TodayStaffing';
import { TodayUrgent } from '@/components/operations/TodayUrgent';
import { LoadingBlock } from '@/components/ui/primitives';

export const metadata = { title: "Today — MAKAM Home Stays" };

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
      {(board) => (
        <>
          {/*
            * Above the board on purpose. Urgent work with no owner is the one thing on this
            * screen that will not resolve itself, and it renders nothing at all when there is
            * none — so it costs no space on an ordinary morning.
            */}
          <Suspense fallback={null}>
            <TodayUrgent property={params.property} />
          </Suspense>
          <TodayBoard board={board} />
          {/*
            * Streamed rather than awaited: staffing comes from the people domain, and the
            * board must not wait on it. It also renders nothing at all for a viewer without
            * `operations.staff.read`, which is why it is a component and not a prop.
            */}
          <Suspense fallback={<LoadingBlock rows={3} label="Loading staff" />}>
            <TodayStaffing property={params.property} />
          </Suspense>
        </>
      )}
    </ReadOnlyPage>
  );
}
