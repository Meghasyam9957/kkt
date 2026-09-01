/**
 * OPERATIONS TABLES — housekeeping, maintenance, inventory and guest requests.
 *
 * Server components (rendered inside ops pages) that emit client action buttons per
 * row. Money never appears here: the operations surfaces show what needs DOING —
 * financial columns live on the finance screens, per role design.
 *
 * Every action posts to the mutation API with a fresh intent per opened flow; the
 * server validates transitions, so an illegal action comes back as a readable 422
 * (surfaced in the toast) rather than being hidden client-side. Buttons are still only
 * OFFERED where they make sense, to keep the board calm.
 *
 * The two BOOKING tables that used to live here are gone. `OpsReservationsTable` was a
 * second rendering of the Bookings workspace and `ArrivalsTable` a second rendering of
 * half the Today board — both over the same payloads as the screens they duplicated,
 * and both drifting from them (they disagreed about a cancellation's severity, and
 * about which day they were showing). One booking list and one movements board now
 * render every booking in the product.
 */
import { StatusPill, Card, CardHeader, CardBody, type Tone } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RowActionButton } from '@/components/mutations/actions';
import { formatDateShort } from '@/lib/shared/format';
import { resolveMaintenanceFields, markCleanFields } from '@/lib/server/api/form-fields';
import type {
  CleaningRow, MaintenanceRow, StockRow, GuestRequestRow,
} from '@/lib/data/providers/types';

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
