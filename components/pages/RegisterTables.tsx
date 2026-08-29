/**
 * REGISTER TABLES — the property and reservation registers, one table per projection.
 *
 * Two views of each register exist because two audiences do: management reads performance
 * beside the master data; operations reads identity and state only. The split is enforced
 * UPSTREAM in lib/data/views/role-projections.ts — the operational tables take the
 * projected row types, so a financial column cannot be rendered here even by mistake:
 * the field does not exist on the props. The financial tables moved here unchanged from
 * their page files so both variants can be exercised directly by the boundary tests.
 */
import { Card, CardHeader, CardBody, StatusPill, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatDateShort, formatMonthLong } from '@/lib/shared/format';
import type { PropertyBoardRow, ReservationRow, UnitStatus } from '@/lib/data/providers/types';
import type { OperationalPropertyRow, OperationalReservationRow } from '@/lib/data/views/role-projections';

/* ------------------------------------------------------------------ *
 * Properties — financial projection (management)
 * ------------------------------------------------------------------ */

export function FinancialPropertyTable({ rows, period }: { rows: PropertyBoardRow[]; period: string }) {
  const columns: Column<PropertyBoardRow>[] = [
    { key: 'id', header: 'Property ID', render: (r) => <strong>{r.propertyId}</strong> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit },
    { key: 'bhk', header: 'Type', render: (r) => r.bhkType || '—' },
    { key: 'floor', header: 'Floor', numeric: true, render: (r) => r.floor },
    { key: 'bedrooms', header: 'Bedrooms', numeric: true, render: (r) => r.bedrooms },
    { key: 'guests', header: 'Max guests', numeric: true, render: (r) => r.maxGuests || '—' },
    { key: 'listing', header: 'Listing', render: (r) => <ListingPill status={r.listingStatus} /> },
    { key: 'occupancy', header: 'Occupancy', numeric: true, render: (r) => formatPercent(r.occupancyPct, 0) },
    { key: 'revenue', header: 'Net revenue', numeric: true, render: (r) => formatCurrency(r.netRevenue) },
    {
      key: 'profit', header: 'Profit', numeric: true,
      render: (r) => <span className={r.profit < 0 ? 'sv-negative' : ''}>{formatCurrency(r.profit)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Unit register"
        subtitle={`Master data with performance for ${formatMonthLong(period)}. Editing arrives with write access in a later phase.`}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Property register"
          getRowKey={(r) => r.propertyId}
          emptyTitle="No properties match this filter"
          emptyMessage="Clear the property filter to see all four units."
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Properties — operational projection (no financial columns exist on the type)
 * ------------------------------------------------------------------ */

const UNIT_STATUS_TONE: Record<UnitStatus, Tone> = {
  Available: 'good', Occupied: 'info', Cleaning: 'warn', Maintenance: 'bad', Blocked: 'neutral',
};

export function OperationalPropertyTable({ rows, period }: { rows: OperationalPropertyRow[]; period: string }) {
  const columns: Column<OperationalPropertyRow>[] = [
    { key: 'id', header: 'Property ID', render: (r) => <strong>{r.propertyId}</strong> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit },
    { key: 'bhk', header: 'Type', render: (r) => r.bhkType || '—' },
    { key: 'floor', header: 'Floor', numeric: true, render: (r) => r.floor },
    { key: 'bedrooms', header: 'Bedrooms', numeric: true, render: (r) => r.bedrooms },
    { key: 'guests', header: 'Max guests', numeric: true, render: (r) => r.maxGuests || '—' },
    { key: 'listing', header: 'Listing', render: (r) => <ListingPill status={r.listingStatus} /> },
    { key: 'occupancy', header: 'Occupancy', numeric: true, render: (r) => formatPercent(r.occupancyPct, 0) },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={UNIT_STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
    { key: 'note', header: 'Note', render: (r) => r.statusDetail ?? '—' },
  ];

  return (
    <Card>
      <CardHeader
        title="Unit register"
        subtitle={`Master data and unit status for ${formatMonthLong(period)}. Revenue and profit live on the finance screens.`}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Property register"
          getRowKey={(r) => r.propertyId}
          emptyTitle="No properties match this filter"
          emptyMessage="Clear the property filter to see all four units."
        />
      </CardBody>
    </Card>
  );
}

function ListingPill({ status }: { status: string }) {
  const label = status || '—';
  return <StatusPill tone={label === 'Live' ? 'good' : 'neutral'}>{label}</StatusPill>;
}

/* ------------------------------------------------------------------ *
 * Reservations — financial projection (management)
 * ------------------------------------------------------------------ */

const BOOKING_TONE: Record<string, Tone> = {
  'Checked In': 'good', 'Checked Out': 'neutral', Confirmed: 'info',
  Cancelled: 'warn', 'No Show': 'bad', Inquiry: 'warn',
};
const PAYOUT_TONE: Record<string, Tone> = {
  Received: 'good', Partial: 'info', Pending: 'warn', Awaiting: 'warn', '—': 'neutral',
};

export function FinancialReservationsTable({ rows, period }: { rows: ReservationRow[]; period: string }) {
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
