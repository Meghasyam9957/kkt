import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { FinancialReservationsTable } from '@/components/pages/RegisterTables';
import { OpsReservationsTable } from '@/components/pages/OpsTables';
import { operationalReservationRows } from '@/lib/data/views/role-projections';
import { roleSeesFinancialFigures } from '@/lib/shared/roles';

export const metadata = { title: 'Reservations — MAKAM Home Stays' };

/**
 * Shared register, role-scoped columns. A role with no financial capability gets the
 * OPERATIONAL projection — booking values and payout fields are stripped on the server
 * before render — and the same lifecycle table the operations screens use, actions
 * included, since that role holds reservations.write.
 */
export default async function ReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Reservations"
      description={(viewer) => roleSeesFinancialFigures(viewer.role)
        ? 'Bookings arriving in the selected month. Guest names are minimised in this list view — contact details are never shown here.'
        : 'Bookings arriving in the selected month. Guest names are minimised in this list view — payouts and revenue live on the finance screens.'}
      searchParams={params}
      fetcher={(provider, filters) => provider.getReservations(filters)}
    >
      {(rows, envelope, viewer) => (roleSeesFinancialFigures(viewer.role)
        ? <FinancialReservationsTable rows={rows} period={envelope.meta.period} />
        : <OpsReservationsTable rows={operationalReservationRows(rows)} />)}
    </ReadOnlyPage>
  );
}
