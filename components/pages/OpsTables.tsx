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
import { AssignTaskButton } from '@/components/operations/AssignTaskButton';
import type { AssignmentContext } from '@/lib/server/operations/assign-context';
import { formatDateShort } from '@/lib/shared/format';
import { resolveMaintenanceFields, markCleanFields } from '@/lib/server/api/form-fields';
import type {
  CleaningRow, MaintenanceRow, StockRow, GuestRequestRow,
} from '@/lib/data/providers/types';

const HK_TONE: Record<string, Tone> = {
  Completed: 'good', 'In Progress': 'info', Assigned: 'info',
  Pending: 'warn', 'Failed Inspection': 'bad',
};
/* The INSPECTION list, in the same vocabulary the turnover statuses use. */
const INSPECTION_TONE: Record<string, Tone> = {
  Passed: 'good', Pending: 'warn', Failed: 'bad',
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

/**
 * THE BOOKING REFERENCE RECORDED ON A TURNOVER — read forward, never backward.
 *
 * 13_HOUSEKEEPING has a BookingID column. Nothing validates it against the register,
 * nothing makes it unique, and every seeded turnover in both demo sources leaves it
 * empty — so a value here is a note somebody made, and its ABSENCE is not evidence that
 * a booking had no turnover. Shown for what it is: the reference, plus the guest's
 * minimised name when the register actually holds that booking, and an honest
 * "not in the register" when it does not.
 */
function BookingRef({ row }: { row: CleaningRow }) {
  if (row.bookingRef === '') {
    return <span className="sv-hk__noref">None recorded</span>;
  }
  return (
    <span className="sv-hk__ref">
      <code className="numeric">{row.bookingRef}</code>
      {row.bookingKnown
        ? <span className="sv-hk__guest">{row.guestDisplayName}</span>
        : <span className="sv-hk__unknown">not in the register</span>}
    </span>
  );
}

export function HousekeepingTable({ rows, assignment }: {
  rows: CleaningRow[];
  /**
   * Who holds each turnover, and who could. OPTIONAL: the table renders exactly as before
   * without it, so a caller that has not resolved the people domain — or a viewer without
   * `operations.staff.read` — simply sees the board it always saw.
   */
  assignment?: AssignmentContext;
}) {
  const columns: Column<CleaningRow>[] = [
    {
      key: 'unit', header: 'Unit',
      render: (r) => (
        <span className="sv-hk__unit">
          <span className="sv-hk__unitname">{r.unitName || r.propertyId}</span>
          <code className="sv-hk__unitid numeric">{r.propertyId} · {r.taskId}</code>
        </span>
      ),
    },
    { key: 'checkout', header: 'Checkout', render: (r) => formatDateShort(r.checkoutDate) },
    {
      key: 'status', header: 'Turnover',
      render: (r) => <StatusPill tone={HK_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
    {
      /* The result of the step the mark-clean form already asks for. It was written to
         the workbook and never read back, so a front office could record an inspection
         and never see it again. Verbatim — nothing derives it from the status. */
      key: 'inspection', header: 'Inspection',
      render: (r) => (r.inspectionStatus === ''
        ? <span className="sv-hk__noref">Not recorded</span>
        : <StatusPill tone={INSPECTION_TONE[r.inspectionStatus] ?? 'neutral'}>{r.inspectionStatus}</StatusPill>),
    },
    {
      key: 'cleaner', header: 'Cleaner',
      render: (r) => <AssignedCell name={r.cleaner} taskRef={r.taskId} assignment={assignment} />,
    },
    { key: 'booking', header: 'Booking', render: (r) => <BookingRef row={r} /> },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (r.status === 'Completed'
        ? <span className="sv-muted">Done</span>
        : (
          <span className="sv-rowactions">
            {assignment ? (
              <AssignTaskButton
                taskType="HOUSEKEEPING" taskRef={r.taskId} context={assignment}
              />
            ) : null}
            <RowActionButton
              label="Mark clean" endpoint={`/api/housekeeping/${r.taskId}`} method="PATCH"
              surface="drawer"
              confirmTitle={`${r.unitName || r.propertyId} — mark clean`}
              context={<TurnoverFacts row={r} />}
              fields={markCleanFields()}
              successTemplate={`${r.unitName || r.propertyId} is ready — ${r.taskId} completed.`}
            />
          </span>
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
          /* Below 640px each turnover becomes a stacked record carrying its own column
             labels: a front office reads this one unit at a time on a phone. */
          mobile="stack"
          getRowKey={(r) => r.taskId} emptyTitle="No turnovers outstanding"
          emptyMessage="Every unit is ready."
        />
      </CardBody>
    </Card>
  );
}

/**
 * The turnover restated above the mark-clean fields. Context only — nothing is submitted,
 * and nothing here is a figure.
 */
function TurnoverFacts({ row }: { row: CleaningRow }) {
  return (
    <dl className="sv-staycontext">
      <div><dt>Unit</dt><dd>{row.unitName || row.propertyId}</dd></div>
      <div><dt>Task</dt><dd className="numeric">{row.taskId}</dd></div>
      <div><dt>After checkout</dt><dd>{formatDateShort(row.checkoutDate)}</dd></div>
      <div><dt>Turnover</dt><dd>{row.status}</dd></div>
    </dl>
  );
}

/* ------------------------------------------------------------------ *
 * Maintenance
 * ------------------------------------------------------------------ */

export function MaintenanceTable({ rows, assignment }: {
  rows: MaintenanceRow[];
  /** As on the housekeeping board: optional, and the table is unchanged without it. */
  assignment?: AssignmentContext;
}) {
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
      key: 'assigned', header: 'Technician',
      render: (r) => (
        <AssignedCell name={r.assignedTo} taskRef={r.ticketId} assignment={assignment} />
      ),
    },
    {
      key: 'actions', header: 'Actions',
      render: (r) => (r.status === 'Resolved' || r.status === 'Closed'
        ? <span className="sv-muted">—</span>
        : (
          <span className="sv-rowactions">
            {assignment ? (
              <AssignTaskButton
                taskType="MAINTENANCE" taskRef={r.ticketId} context={assignment}
              />
            ) : null}
            <RowActionButton
              label="Resolve" endpoint={`/api/maintenance/${r.ticketId}`} method="PATCH"
              confirmTitle={`Resolve ${r.ticketId}`}
              fields={resolveMaintenanceFields()}
              successTemplate={`${r.ticketId} resolved.`}
            />
          </span>
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


/**
 * WHO HOLDS THIS TASK, and whether the workbook and the overlay agree about it.
 *
 * Three states a supervisor can act on, and the distinction is the point of M-OPS-2:
 *
 *   nobody yet   no name in the sheet and no assignment. Ordinary, not a problem.
 *   linked       an assignment exists. The name shown is the person the record names.
 *   unlinked     the sheet holds a name that no assignment stands behind. Every row
 *                predating this feature looks like this, and so does every row a
 *                supervisor typed into the sheet by hand — so it is stated plainly and
 *                never treated as an error.
 *
 * The name is always the HUMAN one. No identifier is rendered here: a screen that showed a
 * uuid where a person's name belongs would be unreadable exactly when it mattered.
 */
function AssignedCell({ name, taskRef, assignment }: {
  name: string;
  taskRef: string;
  assignment?: AssignmentContext;
}) {
  const current = assignment?.current[taskRef];

  if (current) {
    const diverged = name.trim() !== '' && name.trim() !== current.displayName.trim();
    return (
      <span className="sv-assigned">
        <span className="sv-assigned__name">{current.displayName}</span>
        {diverged ? (
          // The sheet cell was edited to somebody else after we wrote it. Reported, never
          // silently resolved — which of the two is right is not ours to decide.
          <StatusPill tone="warn">sheet says {name}</StatusPill>
        ) : null}
      </span>
    );
  }

  if (name.trim() === '') return <span className="sv-hk__noref">Nobody yet</span>;

  return (
    <span className="sv-assigned">
      <span className="sv-assigned__name">{name}</span>
      {assignment ? <StatusPill tone="neutral">unlinked</StatusPill> : null}
    </span>
  );
}
