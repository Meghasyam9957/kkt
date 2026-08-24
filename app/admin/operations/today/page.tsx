/**
 * TODAY'S OPERATIONS — the morning board.
 *
 * Built for someone standing up, not sitting down. What needs a person comes first, with
 * the action spelled out beside it; the counters and the lists follow.
 *
 * **No financial figure appears on this screen.** Not revenue, not a rate, not a payout.
 * The operations role holds no financial capability, and a board that shows money beside a
 * cleaning task both leaks it and pulls attention to the wrong decision.
 *
 * Every record here comes from the data provider — the same one every other screen uses.
 * It previously read the demo fixtures directly, which meant a production deployment would
 * have rendered fictional tickets on a real operations board.
 */
import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill, EmptyState } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatDate, formatDateShort } from '@/lib/shared/format';
import type {
  OperationsBoardView, MaintenanceRow, StockRow, ArrivalRow, CleaningRow, GuestRequestRow,
  UrgentItem,
} from '@/lib/data/providers/types';

export const metadata = { title: "Today's operations — Srivillu Home Stays" };

export default async function TodayPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="operations.view"
      title="Today's operations"
      description="What needs doing today: arrivals, departures, turnovers, tickets, stock and guest requests. No financial figures appear on this screen."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, filters) => provider.getOperations(filters)}
    >
      {(board) => <OperationsBoard board={board} />}
    </ReadOnlyPage>
  );
}

const PRIORITY_TONE: Record<string, 'bad' | 'warn' | 'info' | 'neutral'> = {
  Critical: 'bad', High: 'warn', Medium: 'info', Low: 'neutral',
};
const SEVERITY_TONE: Record<UrgentItem['severity'], 'bad' | 'warn' | 'info'> = {
  critical: 'bad', high: 'warn', watch: 'info',
};
const SEVERITY_LABEL: Record<UrgentItem['severity'], string> = {
  critical: 'Critical', high: 'High', watch: 'Watch',
};

function OperationsBoard({ board }: { board: OperationsBoardView }) {
  const tiles = [
    { label: 'Check-ins', value: board.counters.checkIns, key: 'checkIns', tone: 'normal' as const },
    { label: 'Check-outs', value: board.counters.checkOuts, key: 'checkOuts', tone: 'normal' as const },
    { label: 'Pending cleaning', value: board.counters.pendingCleaning, key: 'pendingCleaning', tone: board.counters.pendingCleaning ? 'attention' as const : 'normal' as const },
    { label: 'Open maintenance', value: board.counters.openMaintenance, key: 'openMaintenance', tone: board.counters.openMaintenance ? 'urgent' as const : 'normal' as const },
    { label: 'Low stock', value: board.counters.lowStock, key: 'lowStock', tone: board.counters.lowStock ? 'attention' as const : 'normal' as const },
    { label: 'Guest requests', value: board.counters.guestRequests, key: 'guestRequests', tone: board.counters.guestRequests ? 'attention' as const : 'normal' as const },
  ];
  const untracked = new Set(board.counters.unavailable ?? []);

  return (
    <>
      {/* ---------- What needs a person, first ---------- */}
      <Card>
        <CardHeader
          title="Needs attention"
          subtitle={board.urgent.length === 0
            ? 'Nothing is outstanding.'
            : `${board.urgent.length} item${board.urgent.length === 1 ? '' : 's'} for ${formatDate(board.date)}, most pressing first.`}
        />
        <CardBody>
          {board.urgent.length === 0 ? (
            <EmptyState
              title="Nothing needs attention"
              message="No critical tickets, failed inspections, empty stock lines or open guest requests."
            />
          ) : (
            <ol className="sv-urgent">
              {board.urgent.map((item) => (
                <li key={item.key} className={`sv-urgent__item sv-urgent__item--${item.severity}`}>
                  <div className="sv-urgent__head">
                    <StatusPill tone={SEVERITY_TONE[item.severity]}>{SEVERITY_LABEL[item.severity]}</StatusPill>
                    <span className="sv-urgent__property">{item.propertyId}</span>
                    <span className="sv-urgent__ref numeric">{item.reference}</span>
                  </div>
                  <p className="sv-urgent__title">{item.title}</p>
                  <p className="sv-urgent__action">{item.action}</p>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>

      <Spacer />

      {/* ---------- The shape of the day ---------- */}
      <Card>
        <CardHeader
          title={`Position for ${formatDate(board.date)}`}
          subtitle="Every count is derived from an operational record. Nothing here is entered by hand."
        />
        <CardBody>
          <div className="sv-today">
            {tiles.map((tile) => {
              const missing = untracked.has(tile.key);
              return (
                <div
                  key={tile.label}
                  className={`sv-today__tile ${!missing && tile.tone !== 'normal' ? `sv-today__tile--${tile.tone}` : ''}`}
                >
                  {missing ? (
                    <span className="sv-today__count sv-today__count--none">—</span>
                  ) : (
                    <span className="sv-today__count numeric">{tile.value}</span>
                  )}
                  <span className="sv-today__label">{tile.label}</span>
                  {missing ? <span className="sv-today__note">Not tracked</span> : null}
                  {!missing && tile.tone !== 'normal' ? (
                    <span className="sv-visually-hidden">Needs attention</span>
                  ) : null}
                </div>
              );
            })}
          </div>
        </CardBody>
      </Card>

      <Spacer />

      {/* ---------- Movements ---------- */}
      <div className="sv-split">
        <Card>
          <CardHeader title="Arriving today" subtitle="Guests expected. Names are shortened; contact details are not shown." />
          <CardBody className="sv-card__body--flush">
            <DataTable
              columns={stayColumns} rows={board.arrivals} caption="Arrivals today"
              getRowKey={(row) => row.bookingId}
              emptyTitle="No arrivals today" emptyMessage="Nobody is due to check in."
            />
          </CardBody>
        </Card>

        <Card>
          <CardHeader title="Departing today" subtitle="Units that will need a turnover." />
          <CardBody className="sv-card__body--flush">
            <DataTable
              columns={stayColumns} rows={board.departures} caption="Departures today"
              getRowKey={(row) => row.bookingId}
              emptyTitle="No departures today" emptyMessage="No unit is turning over."
            />
          </CardBody>
        </Card>
      </div>

      <Spacer />

      {/* ---------- Unit status ---------- */}
      <Card>
        <CardHeader title="Unit status" subtitle="Where each unit stands right now." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={[
              { key: 'id', header: 'Property', render: (u) => <strong>{u.propertyId}</strong> },
              { key: 'unit', header: 'Unit', render: (u) => u.unit },
              { key: 'status', header: 'Status', render: (u) => (
                <StatusPill tone={
                  u.status === 'Maintenance' ? 'bad'
                    : u.status === 'Cleaning' ? 'warn'
                      : u.status === 'Occupied' ? 'info' : 'neutral'
                }>{u.status}</StatusPill>
              ) },
              { key: 'detail', header: 'Detail', render: (u) => u.statusDetail ?? '—' },
            ]}
            rows={board.units} caption="Unit status" getRowKey={(u) => u.propertyId}
          />
        </CardBody>
      </Card>

      <Spacer />

      {/* ---------- Work queues ---------- */}
      <Card>
        <CardHeader title="Turnovers outstanding" subtitle="Housekeeping tasks not yet completed." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={cleaningColumns} rows={board.cleaning} caption="Outstanding turnovers"
            getRowKey={(row) => row.taskId}
            emptyTitle="No turnovers outstanding" emptyMessage="Every unit has been cleaned and inspected."
          />
        </CardBody>
      </Card>

      <Spacer />

      <Card>
        <CardHeader title="Open maintenance" subtitle="Tickets that are not yet resolved or closed, most urgent first." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={maintenanceColumns} rows={board.maintenance} caption="Open maintenance tickets"
            getRowKey={(row) => row.ticketId}
            emptyTitle="No open tickets" emptyMessage="Every maintenance ticket is resolved or closed."
          />
        </CardBody>
      </Card>

      <Spacer />

      <Card>
        <CardHeader title="Stock needing attention" subtitle="Items at or below their minimum level." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={stockColumns} rows={board.lowStock} caption="Low stock items"
            getRowKey={(row) => row.itemId}
            emptyTitle="Stock levels are healthy" emptyMessage="No item is at or below its minimum."
          />
        </CardBody>
      </Card>

      <Spacer />

      <Card>
        <CardHeader title="Guest requests" subtitle="Open requests waiting on a reply." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={requestColumns} rows={board.guestRequests} caption="Open guest requests"
            getRowKey={(row) => row.requestId}
            emptyTitle="No open guest requests" emptyMessage="Nothing is waiting on a reply."
          />
        </CardBody>
      </Card>
    </>
  );
}

function Spacer() {
  return <div className="sv-stack-gap" />;
}

const stayColumns: Column<ArrivalRow>[] = [
  { key: 'property', header: 'Property', render: (row) => <strong>{row.propertyId}</strong> },
  { key: 'guest', header: 'Guest', render: (row) => row.guestDisplayName },
  { key: 'nights', header: 'Nights', numeric: true, render: (row) => row.nights },
  { key: 'guests', header: 'Guests', numeric: true, render: (row) => row.guests },
  { key: 'platform', header: 'Channel', render: (row) => row.platform },
  { key: 'status', header: 'Status', render: (row) => row.status },
];

const cleaningColumns: Column<CleaningRow>[] = [
  { key: 'task', header: 'Task', render: (row) => <code className="numeric">{row.taskId}</code> },
  { key: 'property', header: 'Property', render: (row) => row.propertyId },
  { key: 'checkout', header: 'Checkout', render: (row) => formatDateShort(row.checkoutDate) },
  { key: 'status', header: 'Status', render: (row) => (
    <StatusPill tone={row.status === 'Failed Inspection' ? 'bad' : 'warn'}>{row.status}</StatusPill>
  ) },
];

const maintenanceColumns: Column<MaintenanceRow>[] = [
  { key: 'ticket', header: 'Ticket', render: (row) => <code className="numeric">{row.ticketId}</code> },
  { key: 'property', header: 'Property', render: (row) => row.propertyId },
  { key: 'category', header: 'Category', render: (row) => row.category },
  { key: 'description', header: 'Issue', render: (row) => row.description },
  { key: 'priority', header: 'Priority', render: (row) => (
    <StatusPill tone={PRIORITY_TONE[row.priority] ?? 'neutral'}>{row.priority}</StatusPill>
  ) },
  { key: 'status', header: 'Status', render: (row) => row.status },
  { key: 'age', header: 'Open for', numeric: true, render: (row) => `${row.ageDays}d` },
];

const stockColumns: Column<StockRow>[] = [
  { key: 'item', header: 'Item', render: (row) => row.item },
  { key: 'property', header: 'Location', render: (row) => row.propertyId },
  { key: 'current', header: 'In stock', numeric: true, render: (row) => `${row.currentStock} ${row.unit}` },
  { key: 'min', header: 'Minimum', numeric: true, render: (row) => `${row.minStock} ${row.unit}` },
  { key: 'state', header: 'State', render: (row) => (
    <StatusPill tone={row.state === 'Out of stock' ? 'bad' : 'warn'}>{row.state}</StatusPill>
  ) },
];

const requestColumns: Column<GuestRequestRow>[] = [
  { key: 'ref', header: 'Reference', render: (row) => <code className="numeric">{row.requestId}</code> },
  { key: 'property', header: 'Property', render: (row) => row.propertyId },
  { key: 'summary', header: 'Request', render: (row) => row.summary },
  { key: 'raised', header: 'Raised', render: (row) => formatDateShort(row.raisedOn) },
  { key: 'status', header: 'Status', render: (row) => (
    <StatusPill tone={row.status === 'Open' ? 'warn' : 'info'}>{row.status}</StatusPill>
  ) },
];
