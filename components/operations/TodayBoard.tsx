/**
 * TODAY — the front-office command desk.
 *
 * Read top to bottom it answers four questions in order: what day is this, what is
 * happening, what needs a person, and what do I do about it. Every actionable row states
 * WHAT, WHERE and the ACTION on the row itself — no hover, no drill-down, no icon to
 * decode.
 *
 * **No financial figure appears anywhere on this screen.** Operations holds no financial
 * capability; the rows arrive already projected (M-UI-0), so there is nothing to hide.
 *
 * Every action runs the existing verified write path: one operation id per intent, no
 * optimistic state, and an authoritative re-read after the server confirms. Nothing here
 * invents a booking state.
 */
import { Card, CardHeader, CardBody, StatusPill, EmptyState, type Tone } from '@/components/ui/primitives';
import { RowActionButton } from '@/components/mutations/actions';
import { markCleanFields, checkInFields, checkOutFields } from '@/lib/server/api/form-fields';
import { formatDate, formatDateShort } from '@/lib/shared/format';
import { TodayDateControl } from './TodayDateControl';
import type {
  OperationsBoardView, ArrivalRow, CleaningRow, UrgentItem,
} from '@/lib/data/providers/types';

const SEVERITY_TONE: Record<UrgentItem['severity'], Tone> = {
  critical: 'bad', high: 'warn', watch: 'info',
};
const SEVERITY_LABEL: Record<UrgentItem['severity'], string> = {
  critical: 'Critical', high: 'High', watch: 'Watch',
};
const CLEANING_TONE: Record<string, Tone> = {
  'Failed Inspection': 'bad', Pending: 'warn', Assigned: 'info', 'In Progress': 'info',
};

export function TodayBoard({ board }: { board: OperationsBoardView }) {
  /*
   * Derived from rows the provider already returned — a count of what is on screen, not
   * a second source of truth. `units` carries live status, so these two describe RIGHT
   * NOW even when the reader has stepped to another day; the banner below says so.
   */
  const inHouse = board.units.filter((u) => u.status === 'Occupied').length;
  const ready = board.units.filter((u) => u.status === 'Available').length;

  const summary = [
    { key: 'arrivals', label: 'Arrivals', value: board.arrivals.length, live: false },
    { key: 'departures', label: 'Departures', value: board.departures.length, live: false },
    { key: 'inhouse', label: 'In house', value: inHouse, live: true },
    { key: 'ready', label: 'Ready', value: ready, live: true },
    { key: 'cleaning', label: 'Cleaning', value: board.cleaning.length, live: true, attention: board.cleaning.length > 0 },
    { key: 'maintenance', label: 'Maintenance', value: board.maintenance.length, live: true, attention: board.maintenance.length > 0 },
    { key: 'urgent', label: 'Urgent', value: board.urgent.length, live: true, urgent: board.urgent.length > 0 },
  ];

  return (
    <>
      {/* ---------- 1 · Which day ---------- */}
      <TodayDateControl date={board.date} operationalDate={board.operationalDate} />

      {!board.isOperationalDay ? (
        <p className="sv-daynote" role="status">
          Arrivals and departures below are for {formatDate(board.date)}. Turnovers,
          tickets and unit status always show where things stand right now — they are not
          kept as a record of any past morning.
        </p>
      ) : null}

      {/* ---------- 2 · What is happening ---------- */}
      <section className="sv-summary" aria-label={`Position for ${formatDate(board.date)}`}>
        {summary.map((tile) => (
          <div
            key={tile.key}
            className={`sv-summary__tile${tile.urgent ? ' sv-summary__tile--urgent' : tile.attention ? ' sv-summary__tile--attention' : ''}`}
          >
            <span className="sv-summary__value numeric">{tile.value}</span>
            <span className="sv-summary__label">{tile.label}</span>
            {/* Status is never colour alone: the tone is repeated as a word. */}
            {tile.urgent ? <span className="sv-visually-hidden">Needs attention</span> : null}
            {tile.attention && !tile.urgent ? <span className="sv-visually-hidden">Outstanding</span> : null}
          </div>
        ))}
      </section>

      {/* ---------- 3 · Movements, each with its action ---------- */}
      <div className="sv-split">
        <Card variant="object">
          <CardHeader
            title="Arrivals"
            subtitle="Check a guest in when they reach the house."
            action={<span className="sv-muted">{board.arrivals.length}</span>}
          />
          <CardBody className="sv-card__body--flush">
            {board.arrivals.length === 0 ? (
              <EmptyState
                title="No arrivals today"
                message="Nobody is due to check in on this day."
              />
            ) : (
              <ul className="sv-oplist">
                {board.arrivals.map((row) => (
                  <StayRow key={row.bookingId} row={row} mode="arrival" />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>

        <Card variant="object">
          <CardHeader
            title="Departures"
            subtitle="Check a guest out to release the unit for its turnover."
            action={<span className="sv-muted">{board.departures.length}</span>}
          />
          <CardBody className="sv-card__body--flush">
            {board.departures.length === 0 ? (
              <EmptyState
                title="No departures today"
                message="No unit is turning over on this day."
              />
            ) : (
              <ul className="sv-oplist">
                {board.departures.map((row) => (
                  <StayRow key={row.bookingId} row={row} mode="departure" />
                ))}
              </ul>
            )}
          </CardBody>
        </Card>
      </div>

      {/* ---------- 4 · Turnovers ---------- */}
      <Card variant="object">
        <CardHeader
          title="Housekeeping"
          subtitle="Turnovers still to finish. Marking one clean records who cleaned it and the inspection result."
          action={<span className="sv-muted">{board.cleaning.length} open</span>}
        />
        <CardBody className="sv-card__body--flush">
          {board.cleaning.length === 0 ? (
            <EmptyState
              title="All rooms ready"
              message="Every unit has been cleaned and inspected."
            />
          ) : (
            <ul className="sv-oplist">
              {board.cleaning.map((task) => (
                <CleaningTaskRow key={task.taskId} task={task} />
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      {/* ---------- 5 · What needs a person ---------- */}
      <Card variant="plate">
        <CardHeader
          title="Needs attention"
          subtitle={board.urgent.length === 0
            ? undefined
            : 'Most pressing first. Each line says what happened and what to do.'}
        />
        <CardBody>
          {board.urgent.length === 0 ? (
            <EmptyState
              title="No urgent issues"
              message="No critical tickets, failed inspections, empty stock lines or open guest requests."
            />
          ) : (
            <ol className="sv-urgent">
              {board.urgent.map((item) => (
                <li key={item.key} className={`sv-urgent__item sv-urgent__item--${item.severity}`}>
                  <div className="sv-urgent__head">
                    <StatusPill tone={SEVERITY_TONE[item.severity]}>
                      {SEVERITY_LABEL[item.severity]}
                    </StatusPill>
                    <span className="sv-urgent__property">{item.propertyId}</span>
                  </div>
                  <p className="sv-urgent__title">{item.title}</p>
                  <p className="sv-urgent__action">{item.action}</p>
                </li>
              ))}
            </ol>
          )}
        </CardBody>
      </Card>
    </>
  );
}

/* ------------------------------------------------------------------ *
 * Rows — WHAT · WHERE · ACTION, in that order, always visible
 * ------------------------------------------------------------------ */

function StayRow({ row, mode }: { row: ArrivalRow; mode: 'arrival' | 'departure' }) {
  /*
   * The action is offered only where the booking can legally take it — the same
   * transition table the server enforces (Confirmed → Checked In → Checked Out). The
   * server re-checks on submit; this only keeps dead buttons off the board.
   */
  const canCheckIn = mode === 'arrival' && row.status === 'Confirmed';
  const canCheckOut = mode === 'departure' && row.status === 'Checked In';
  const stay = row.checkIn && row.checkOut
    ? `${formatDateShort(row.checkIn)} → ${formatDateShort(row.checkOut)}`
    : null;

  return (
    <li className="sv-oprow">
      <div className="sv-oprow__what">
        <p className="sv-oprow__name">{row.guestDisplayName}</p>
        <p className="sv-oprow__meta">
          <strong className="sv-oprow__where">{row.propertyId}</strong>
          {` · ${row.nights} night${row.nights === 1 ? '' : 's'} · ${row.guests} guest${row.guests === 1 ? '' : 's'} · ${row.platform}`}
        </p>
        {stay ? <p className="sv-oprow__stay">{stay}</p> : null}
      </div>

      <div className="sv-oprow__state">
        <StatusPill tone={row.status === 'Checked In' ? 'good' : row.status === 'Checked Out' ? 'neutral' : 'info'}>
          {row.status}
        </StatusPill>
      </div>

      <div className="sv-oprow__action">
        {canCheckIn ? (
          <RowActionButton
            label="Check in"
            variant="primary"
            size="md"
            surface="drawer"
            endpoint={`/api/reservations/${row.bookingId}/check-in`}
            confirmTitle={`Check in ${row.guestDisplayName}`}
            fields={checkInFields()}
            context={<StayFacts row={row} />}
            successTemplate={`${row.guestDisplayName} is checked in.`}
          />
        ) : canCheckOut ? (
          <RowActionButton
            label="Check out"
            variant="primary"
            size="md"
            surface="drawer"
            endpoint={`/api/reservations/${row.bookingId}/check-out`}
            confirmTitle={`Check out ${row.guestDisplayName}`}
            fields={checkOutFields()}
            context={<StayFacts row={row} />}
            successTemplate={`${row.guestDisplayName} is checked out — the unit needs a turnover.`}
          />
        ) : (
          /* Nothing to do here, said plainly rather than left as an empty cell. */
          <span className="sv-oprow__done">
            {row.status === 'Checked In' ? 'In house' : row.status === 'Checked Out' ? 'Departed' : row.status}
          </span>
        )}
      </div>
    </li>
  );
}

/** The booking, in front of the person, before they commit. Never a figure. */
function StayFacts({ row }: { row: ArrivalRow }) {
  return (
    <dl className="sv-facts">
      <div><dt>Guest</dt><dd>{row.guestDisplayName}</dd></div>
      <div><dt>Unit</dt><dd>{row.propertyId}</dd></div>
      <div><dt>Booking</dt><dd className="numeric">{row.bookingId}</dd></div>
      <div><dt>Stay</dt><dd>{row.nights} night{row.nights === 1 ? '' : 's'}</dd></div>
      <div><dt>Guests</dt><dd>{row.guests}</dd></div>
      <div><dt>Booked via</dt><dd>{row.platform}</dd></div>
    </dl>
  );
}

function CleaningTaskRow({ task }: { task: CleaningRow }) {
  return (
    <li className="sv-oprow">
      <div className="sv-oprow__what">
        <p className="sv-oprow__name">
          <strong className="sv-oprow__where">{task.propertyId}</strong>
        </p>
        <p className="sv-oprow__meta">Turnover after {formatDateShort(task.checkoutDate)}</p>
      </div>

      <div className="sv-oprow__state">
        <StatusPill tone={CLEANING_TONE[task.status] ?? 'neutral'}>{task.status}</StatusPill>
      </div>

      <div className="sv-oprow__action">
        <RowActionButton
          label="Mark clean"
          variant="primary"
          size="md"
          surface="drawer"
          method="PATCH"
          endpoint={`/api/housekeeping/${task.taskId}`}
          confirmTitle={`${task.propertyId} — mark clean`}
          fields={markCleanFields()}
          context={(
            <dl className="sv-facts">
              <div><dt>Unit</dt><dd>{task.propertyId}</dd></div>
              <div><dt>Task</dt><dd className="numeric">{task.taskId}</dd></div>
              <div><dt>After checkout</dt><dd>{formatDateShort(task.checkoutDate)}</dd></div>
              <div><dt>Now</dt><dd>{task.status}</dd></div>
            </dl>
          )}
          successTemplate={`${task.propertyId} is ready.`}
        />
      </div>
    </li>
  );
}
