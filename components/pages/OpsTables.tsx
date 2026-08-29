/**
 * OPERATIONS TABLES — the daybook's registers, with their actions.
 *
 * Server components (rendered inside ops pages) that emit client action buttons per
 * row. Money never appears here: the operations surfaces show what needs DOING —
 * financial columns live on the finance screens, per role design.
 *
 * Every action posts to the mutation API with a fresh intent per opened flow; the
 * server validates transitions, so an illegal action comes back as a readable 422
 * (surfaced in the toast) rather than being hidden client-side. Buttons are still only
 * OFFERED where they make sense, to keep the board calm.
 */
import { StatusPill, Card, CardHeader, CardBody, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionButton } from '@/components/mutations/actions';
import { formatDateShort } from '@/lib/shared/format';
import {
  resolveMaintenanceFields, markCleanFields, cancelReservationFields,
} from '@/lib/server/api/form-fields';
import type {
  ArrivalRow, CleaningRow, MaintenanceRow, StockRow, GuestRequestRow,
} from '@/lib/data/providers/types';
// The PROJECTED row type, not the full one: payout figures do not exist on these props,
// so this table cannot render one even by mistake (lib/data/views/role-projections.ts).
import type { OperationalReservationRow } from '@/lib/data/views/role-projections';

const BOOKING_TONE: Record<string, Tone> = {
  Confirmed: 'info', 'Checked In': 'good', 'Checked Out': 'neutral',
  Inquiry: 'warn', Cancelled: 'bad', 'No Show': 'bad',
};
const HK_TONE: Record<string, Tone> = {
  Completed: 'good', 'In Progress': 'info', Assigned: 'info',
  Pending: 'warn', 'Failed Inspection': 'bad',
};
const MNT_TONE: Record<string, Tone> = {
  Open: 'bad', Assigned: 'warn', 'In Progress': 'info', Waiting: 'warn',
  Resolved: 'good', Closed: 'neutral',
};
const PRIORITY_TONE: Record<string, Tone> = {
  Critical: 'bad', High: 'warn', Medium: 'info', Low: 'neutral',
};

/* ------------------------------------------------------------------ *
 * Reservations (operational columns only — no payout figures here)
 * ------------------------------------------------------------------ */

export function OpsReservationsTable({ rows }: { rows: OperationalReservationRow[] }) {
  const columns: Column<OperationalReservationRow>[] = [
    { key: 'id', header: 'Booking', render: (r) => <code className="numeric">{r.bookingId}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    { key: 'guest', header: 'Guest', render: (r) => r.guestDisplayName },
    { key: 'in', header: 'Check-in', render: (r) => formatDateShort(r.checkIn) },
    { key: 'out', header: 'Check-out', render: (r) => formatDateShort(r.checkOut) },
    { key: 'nights', header: 'Nights', numeric: true, render: (r) => String(r.nights || '—') },
    { key: 'platform', header: 'Platform', render: (r) => r.platform },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={BOOKING_TONE[r.bookingStatus] ?? 'neutral'}>{r.bookingStatus}</StatusPill>,
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => <ReservationActions row={r} />,
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Reservations"
        subtitle="Operational view — payouts and revenue live on the finance screens."
        action={<span className="sv-muted">{rows.length} booking{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Reservations register"
          getRowKey={(r) => r.bookingId} emptyTitle="No reservations this month"
          emptyMessage="Try a different month, or create the booking."
        />
      </CardBody>
    </Card>
  );
}

/** Which lifecycle actions a booking legally offers. The SERVER re-checks on submit —
 *  this only keeps dead buttons off the board. */
function ReservationActions({ row }: { row: OperationalReservationRow }) {
  const base = `/api/reservations/${row.bookingId}`;
  return (
    <span className="sv-row-actions">
      {row.bookingStatus === 'Confirmed' ? (
        <RowActionButton
          label="Check In" endpoint={`${base}/check-in`}
          successTemplate={`${row.bookingId} checked in.`}
        />
      ) : null}
      {row.bookingStatus === 'Checked In' ? (
        <RowActionButton
          label="Check Out" endpoint={`${base}/check-out`}
          successTemplate={`${row.bookingId} checked out.`}
        />
      ) : null}
      {row.bookingStatus === 'Confirmed' || row.bookingStatus === 'Inquiry' ? (
        <RowActionButton
          label="Cancel" endpoint={`${base}/cancel`} variant="danger"
          confirmTitle={`Cancel ${row.bookingId}?`}
          fields={cancelReservationFields()}
          successTemplate={`${row.bookingId} cancelled — the row remains in the ledger.`}
        />
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ *
 * Arrivals / departures (check-in and check-out screens)
 * ------------------------------------------------------------------ */

export function ArrivalsTable({ rows, mode }: { rows: ArrivalRow[]; mode: 'checkin' | 'checkout' }) {
  const columns: Column<ArrivalRow>[] = [
    { key: 'id', header: 'Booking', render: (r) => <code className="numeric">{r.bookingId}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    { key: 'guest', header: 'Guest', render: (r) => r.guestDisplayName },
    { key: 'nights', header: 'Nights', numeric: true, render: (r) => String(r.nights) },
    { key: 'guests', header: 'Guests', numeric: true, render: (r) => String(r.guests) },
    { key: 'platform', header: 'Platform', render: (r) => r.platform },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={BOOKING_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
    {
      key: 'action', header: 'Action',
      render: (r) => (mode === 'checkin'
        ? (r.status === 'Confirmed'
          ? <RowActionButton label="Check In" endpoint={`/api/reservations/${r.bookingId}/check-in`}
              successTemplate={`${r.bookingId} checked in.`} />
          : <span className="sv-muted">—</span>)
        : (r.status === 'Checked In'
          ? <RowActionButton label="Check Out" endpoint={`/api/reservations/${r.bookingId}/check-out`}
              successTemplate={`${r.bookingId} checked out.`} />
          : <span className="sv-muted">—</span>)),
    },
  ];
  return (
    <Card>
      <CardHeader
        title={mode === 'checkin' ? "Today's arrivals" : "Today's departures"}
        subtitle={mode === 'checkin'
          ? 'Guests expected today. Check them in as they arrive.'
          : 'Guests leaving today. Check them out as they go — housekeeping follows.'}
        action={<span className="sv-muted">{rows.length}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows}
          caption={mode === 'checkin' ? 'Arrivals' : 'Departures'}
          getRowKey={(r) => r.bookingId}
          emptyTitle={mode === 'checkin' ? 'No arrivals today' : 'No departures today'}
          emptyMessage="A quiet day on this front."
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Housekeeping
 * ------------------------------------------------------------------ */

export function HousekeepingTable({ rows }: { rows: CleaningRow[] }) {
  const columns: Column<CleaningRow>[] = [
    { key: 'id', header: 'Task', render: (r) => <code className="numeric">{r.taskId}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    { key: 'checkout', header: 'After checkout', render: (r) => formatDateShort(r.checkoutDate) },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={HK_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (r.status === 'Completed'
        ? <span className="sv-muted">Done</span>
        : (
          <RowActionButton
            label="Mark Clean" endpoint={`/api/housekeeping/${r.taskId}`} method="PATCH"
            confirmTitle={`Turnover ${r.taskId} — mark clean`}
            fields={markCleanFields()}
            successTemplate={`${r.taskId} completed — the unit is ready.`}
          />
        )),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Turnovers"
        subtitle="Cleaning between stays. Marking a turnover clean records who cleaned and the inspection result."
        action={<span className="sv-muted">{rows.length} open</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Housekeeping register"
          getRowKey={(r) => r.taskId} emptyTitle="No turnovers outstanding"
          emptyMessage="Every unit is ready."
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Maintenance
 * ------------------------------------------------------------------ */

export function MaintenanceTable({ rows }: { rows: MaintenanceRow[] }) {
  const columns: Column<MaintenanceRow>[] = [
    { key: 'id', header: 'Ticket', render: (r) => <code className="numeric">{r.ticketId}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    {
      key: 'issue', header: 'Issue',
      render: (r) => (
        <span>
          {r.category}
          <span className="sv-muted"> · {r.description}</span>
        </span>
      ),
    },
    { key: 'reported', header: 'Reported', render: (r) => formatDateShort(r.reportedOn) },
    { key: 'age', header: 'Age', numeric: true, render: (r) => `${r.ageDays}d` },
    {
      key: 'priority', header: 'Priority',
      render: (r) => <StatusPill tone={PRIORITY_TONE[r.priority] ?? 'neutral'}>{r.priority}</StatusPill>,
    },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={MNT_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (r.status === 'Resolved' || r.status === 'Closed'
        ? <span className="sv-muted">—</span>
        : (
          <RowActionButton
            label="Resolve" endpoint={`/api/maintenance/${r.ticketId}`} method="PATCH"
            confirmTitle={`Resolve ${r.ticketId}`}
            fields={resolveMaintenanceFields()}
            successTemplate={`${r.ticketId} resolved.`}
          />
        )),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Open tickets"
        subtitle="Most pressing first. Resolving a ticket records the date and, where known, the cost and the linked expense."
        action={<span className="sv-muted">{rows.length} open</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Maintenance register"
          getRowKey={(r) => r.ticketId} emptyTitle="No open tickets"
          emptyMessage="Nothing is broken that anyone has reported."
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Inventory
 * ------------------------------------------------------------------ */

export function InventoryTable({ rows, movementFields }: {
  rows: StockRow[];
  movementFields: import('@/components/mutations/MutationForm').FieldSpec[];
}) {
  const columns: Column<StockRow>[] = [
    { key: 'id', header: 'Item ID', render: (r) => <code className="numeric">{r.itemId}</code> },
    { key: 'item', header: 'Item', render: (r) => `${r.item} (${r.unit})` },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    {
      key: 'stock', header: 'In stock', numeric: true,
      render: (r) => <span className="numeric">{r.currentStock}</span>,
    },
    { key: 'min', header: 'Minimum', numeric: true, render: (r) => String(r.minStock) },
    {
      key: 'state', header: 'State',
      render: (r) => (
        <StatusPill tone={r.state === 'Out of stock' ? 'bad' : r.state === 'Low' ? 'warn' : 'good'}>
          {r.state}
        </StatusPill>
      ),
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (
        <RowActionButton
          label="Movement" endpoint={`/api/inventory/${r.itemId}`} method="PATCH"
          confirmTitle={`Stock movement — ${r.item}`}
          fields={movementFields}
          successTemplate={`${r.itemId} updated — current stock is recalculated by the workbook.`}
        />
      ),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Stock register"
        subtitle="Current stock is a workbook calculation (opening + purchased − used). A movement records the inputs; the workbook does the arithmetic."
        action={<span className="sv-muted">{rows.length} item{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Inventory register"
          getRowKey={(r) => r.itemId} emptyTitle="No inventory tracked"
          emptyMessage="Add items in the workbook's 15_INVENTORY sheet."
        />
      </CardBody>
    </Card>
  );
}

/* ------------------------------------------------------------------ *
 * Guest requests
 * ------------------------------------------------------------------ */

export function GuestRequestsTable({ rows, tracked }: { rows: GuestRequestRow[]; tracked: boolean }) {
  const columns: Column<GuestRequestRow>[] = [
    { key: 'id', header: 'Request', render: (r) => <code className="numeric">{r.requestId}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId },
    { key: 'summary', header: 'What the guest needs', render: (r) => r.summary },
    { key: 'raised', header: 'Raised', render: (r) => r.raisedOn },
    {
      key: 'status', header: 'Status',
      render: (r) => (
        <StatusPill tone={r.status === 'Resolved' ? 'good' : r.status === 'New' ? 'warn' : 'info'}>
          {r.status}
        </StatusPill>
      ),
    },
  ];
  return (
    <Card>
      <CardHeader
        title="Open requests"
        subtitle={tracked
          ? 'What guests have asked for, oldest first.'
          : 'Not tracked by the live workbook — guest requests have no V1 sheet yet. Shown here from demonstration data only.'}
        action={<span className="sv-muted">{rows.length} open</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Guest requests"
          getRowKey={(r) => r.requestId} emptyTitle="No open requests"
          emptyMessage="Nobody needs anything right now."
        />
      </CardBody>
    </Card>
  );
}
