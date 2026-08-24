import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort, formatMonthLong } from '@/lib/shared/format';
import type { ReservationRow } from '@/lib/data/providers/types';

export const metadata = { title: 'Reservations — Srivillu Home Stays' };

const BOOKING_TONE: Record<string, 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  'Checked In': 'good', 'Checked Out': 'neutral', Confirmed: 'info',
  Cancelled: 'warn', 'No Show': 'bad', Inquiry: 'warn',
};
const PAYOUT_TONE: Record<string, 'good' | 'info' | 'warn' | 'bad' | 'neutral'> = {
  Received: 'good', Partial: 'info', Pending: 'warn', Awaiting: 'warn', '—': 'neutral',
};

export default async function ReservationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Reservations"
      description="Bookings arriving in the selected month. Guest names are minimised in this list view — contact details are never shown here."
      searchParams={params}
      fetcher={(provider, filters) => provider.getReservations(filters)}
    >
      {(rows, envelope) => <ReservationsTable rows={rows} period={envelope.meta.period} />}
    </ReadOnlyPage>
  );
}

function ReservationsTable({ rows, period }: { rows: ReservationRow[]; period: string }) {
  const totalGross = rows.reduce((t, r) => t + r.grossValue, 0);
  const totalExpected = rows.reduce((t, r) => t + r.expectedPayout, 0);

  const columns: Column<ReservationRow>[] = [
    { key: 'id', header: 'Booking ID', render: (r) => <code className="numeric">{r.bookingId}</code>, footer: 'Total' },
    { key: 'platform', header: 'Platform', render: (r) => r.platform },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={BOOKING_TONE[r.bookingStatus] ?? 'neutral'}>{r.bookingStatus}</StatusPill>,
    },
    { key: 'guest', header: 'Guest', render: (r) => r.guestDisplayName },
    { key: 'checkin', header: 'Check-in', render: (r) => formatDateShort(r.checkIn) },
    { key: 'checkout', header: 'Check-out', render: (r) => formatDateShort(r.checkOut) },
    { key: 'nights', header: 'Nights', numeric: true, render: (r) => r.nights },
    { key: 'gross', header: 'Gross value', numeric: true, render: (r) => formatCurrency(r.grossValue), footer: formatCurrency(totalGross) },
    { key: 'expected', header: 'Expected payout', numeric: true, render: (r) => formatCurrency(r.expectedPayout), footer: formatCurrency(totalExpected) },
    {
      key: 'payout', header: 'Payout',
      render: (r) => <StatusPill tone={PAYOUT_TONE[r.payoutStatus] ?? 'neutral'}>{r.payoutStatus}</StatusPill>,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Reservations"
        subtitle={`Arrivals in ${formatMonthLong(period)}.`}
        action={<span className="sv-muted">{rows.length} booking{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Reservations"
          getRowKey={(r) => r.bookingId} footer
          emptyTitle="No reservations for this period"
          emptyMessage="No bookings arrive in the selected month with these filters."
        />
      </CardBody>
    </Card>
  );
}
