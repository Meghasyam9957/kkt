'use client';
/**
 * THE BOOKINGS WORKSPACE — the front office's one booking screen.
 *
 * Find a booking, see where it stands, act on it. Everything above the list narrows what
 * is already on screen; nothing here fetches, and nothing here can widen what the server
 * chose to send.
 *
 * **Search, status and sort run over the rows the server already sent** — the operational
 * projection, in which no financial field exists (lib/data/views/role-projections.ts).
 * That is deliberate and load-bearing: a search box that queried the server would be a
 * second read path with its own scoping to get wrong, and a search that matched a field
 * the table does not show would quietly widen disclosure. Neither is possible here,
 * because the only data this component has ever seen is the data it renders.
 *
 * SCOPE is the exception, and it lives in the URL: switching between "arriving this
 * month" and "staying on this day" changes WHICH bookings the server selects, so it is a
 * server round-trip and a shareable address, exactly like the Today board's day control.
 *
 * Actions run the existing verified write path — one operation id per intent, no
 * optimistic state, `router.refresh()` as the authoritative re-read. No booking state is
 * computed here.
 */
import { useCallback, useMemo, useState, useTransition, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  Card, CardHeader, CardBody, StatusPill, EmptyState, Button, Chip,
} from '@/components/ui/primitives';
import { DataTable, type Column, type SortState } from '@/components/ui/DataTable';
import { RowActionButton } from '@/components/mutations/actions';
import type { FieldSpec } from '@/components/mutations/MutationForm';
import { formatDate, formatDateShort } from '@/lib/shared/format';
import { bookingStatusTone, bookingStatusRank } from '@/lib/shared/booking-status';
import { BOOKING_PARAM } from './BookingDetailDrawer';
import type { PropertyOption } from '@/lib/data/providers/types';
import type { OperationalReservationRow } from '@/lib/data/views/role-projections';

export type BookingScope = 'month' | 'in-progress';

export interface BookingsWorkspaceProps {
  /**
   * The role projection, never the full row. A financial field does not exist on this
   * type, so this component cannot render, search or sort by one.
   */
  rows: OperationalReservationRow[];
  /**
   * Unit identity for the WHERE column and the search index. `PropertyOption` carries no
   * performance or financial field by construction, so any role's screen may hold it.
   */
  units: PropertyOption[];
  scope: BookingScope;
  /** The day the in-progress scope is measured against; resolved by the view. */
  date: string;
  isOperationalDay: boolean;
  /** The reporting month, for the month scope's heading. */
  periodLabel: string;
  /** Field specs built on the server from the V1 contract — never assembled here. */
  checkInFields: FieldSpec[];
  checkOutFields: FieldSpec[];
  /**
   * The detail panel for `?booking=`, already resolved and projected on the server.
   * Rendered as a child so this component never decides what a booking may disclose.
   */
  detail?: ReactNode;
}

/** The one legal next step for a booking, or null when the stay is over. */
function primaryAction(status: string): 'check-in' | 'check-out' | null {
  if (status === 'Confirmed') return 'check-in';
  if (status === 'Checked In') return 'check-out';
  return null;
}

/** What to say in the action cell when there is nothing left to do. */
function restingLabel(status: string): string {
  if (status === 'Checked Out') return 'Departed';
  if (status === 'Inquiry') return 'Not confirmed';
  return status;
}

export function BookingsWorkspace({
  rows, units, scope, date, isOperationalDay, periodLabel,
  checkInFields, checkOutFields, detail,
}: BookingsWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // Changing scope is a server round-trip. `isPending` is a real loading state, not a
  // decorative one: it covers exactly the window in which the list on screen is stale.
  const [pending, startTransition] = useTransition();

  const [query, setQuery] = useState('');
  const [status, setStatus] = useState<string>('all');
  const [sort, setSort] = useState<SortState>({ key: 'checkIn', direction: 'asc' });

  const unitName = useMemo(() => {
    const byId = new Map(units.map((u) => [u.id, u.name]));
    return (id: string) => byId.get(id) ?? '';
  }, [units]);

  const setScope = useCallback((next: BookingScope) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === 'month') params.delete('scope');
    else params.set('scope', next);
    const search = params.toString();
    startTransition(() => {
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    });
  }, [router, pathname, searchParams]);

  /* ---- narrowing, in one pass over rows already in hand ---- */

  const term = query.trim().toLowerCase();
  const visible = useMemo(() => {
    const matches = (row: OperationalReservationRow) => {
      if (status !== 'all' && row.bookingStatus !== status) return false;
      if (!term) return true;
      // Exactly the fields the row displays. Nothing is searchable that is not visible —
      // a hidden matchable field is a disclosure the reader cannot see or verify.
      return [
        row.bookingId, row.guestDisplayName, row.propertyId,
        unitName(row.propertyId), row.platform,
      ].some((field) => field.toLowerCase().includes(term));
    };

    const direction = sort.direction === 'asc' ? 1 : -1;
    // Nulls sort last in BOTH directions: an unknown date is not "earliest" or "latest",
    // it is absent, and floating it to the top of a front-office list is noise.
    const text = (a: string, b: string) => a.localeCompare(b) * direction;
    const day = (a: string | null, b: string | null) => {
      if (a === b) return 0;
      if (!a) return 1;
      if (!b) return -1;
      return a.localeCompare(b) * direction;
    };

    const compare = (a: OperationalReservationRow, b: OperationalReservationRow): number => {
      switch (sort.key) {
        case 'guest': return text(a.guestDisplayName, b.guestDisplayName);
        case 'unit': return text(unitName(a.propertyId) || a.propertyId, unitName(b.propertyId) || b.propertyId);
        case 'checkIn': return day(a.checkIn, b.checkIn);
        case 'checkOut': return day(a.checkOut, b.checkOut);
        // Lifecycle order, not alphabetical — see lib/shared/booking-status.ts.
        case 'status': return (bookingStatusRank(a.bookingStatus) - bookingStatusRank(b.bookingStatus)) * direction;
        default: return text(a.bookingId, b.bookingId);
      }
    };

    // A stable tie-break on the booking id, so equal keys never shuffle between renders.
    return rows.filter(matches).sort((a, b) => compare(a, b) || a.bookingId.localeCompare(b.bookingId));
  }, [rows, term, status, sort, unitName]);

  /* ---- status chips: only statuses actually present, each with its real count ---- */
  const counts = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of rows) map.set(row.bookingStatus, (map.get(row.bookingStatus) ?? 0) + 1);
    return [...map.entries()].sort((a, b) => bookingStatusRank(a[0]) - bookingStatusRank(b[0]));
  }, [rows]);

  const narrowed = term !== '' || status !== 'all';
  const clear = () => { setQuery(''); setStatus('all'); };

  const onSort = (key: string) => setSort((current) => (current.key === key
    ? { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
    : { key, direction: 'asc' }));

  /** The address of one booking, keeping whatever scope and filters are already set. */
  const hrefFor = (bookingId: string): string => {
    const params = new URLSearchParams(searchParams.toString());
    params.set(BOOKING_PARAM, bookingId);
    return `${pathname}?${params.toString()}`;
  };

  /* ---- columns: WHAT · WHO · WHERE · WHEN · STATUS · ACTION ---- */

  const columns: Column<OperationalReservationRow>[] = [
    {
      key: 'booking', header: 'Booking', sortable: true,
      render: (r) => (
        <span className="sv-bkcell">
          {/* A real link, not a click handler: it pushes history (so Back closes the
              panel), survives a middle-click into a new tab, and is a shareable
              address for one booking. */}
          <Link
            className="sv-bklink"
            href={hrefFor(r.bookingId)}
            scroll={false}
            aria-label={`Open booking ${r.bookingId} for ${r.guestDisplayName}`}
          >
            <code className="numeric">{r.bookingId}</code>
          </Link>
          <span className="sv-bkcell__sub">{r.platform}</span>
        </span>
      ),
    },
    { key: 'guest', header: 'Guest', sortable: true, render: (r) => r.guestDisplayName },
    {
      key: 'unit', header: 'Unit', sortable: true,
      render: (r) => (
        <span className="sv-bkcell">
          <span>{unitName(r.propertyId) || r.propertyId}</span>
          {unitName(r.propertyId) ? <span className="sv-bkcell__sub">{r.propertyId}</span> : null}
        </span>
      ),
    },
    {
      key: 'checkIn', header: 'Check-in', sortable: true,
      render: (r) => formatDateShort(r.checkIn),
    },
    {
      key: 'checkOut', header: 'Check-out', sortable: true,
      render: (r) => (
        <span className="sv-bkcell">
          <span>{formatDateShort(r.checkOut)}</span>
          <span className="sv-bkcell__sub">{r.nights} night{r.nights === 1 ? '' : 's'}</span>
        </span>
      ),
    },
    {
      key: 'status', header: 'Status', sortable: true,
      render: (r) => <StatusPill tone={bookingStatusTone(r.bookingStatus)}>{r.bookingStatus}</StatusPill>,
    },
    {
      key: 'action', header: 'Action',
      render: (r) => (
        <BookingRowAction
          row={r}
          checkInFields={checkInFields}
          checkOutFields={checkOutFields}
        />
      ),
    },
  ];

  // One phrasing for the day, so the chip, the caption and the empty state cannot drift.
  // "today" already reads as an adverb; a date needs the preposition.
  const stayingWhen = isOperationalDay ? 'today' : `on ${formatDate(date)}`;
  const scopeLabel = scope === 'in-progress'
    ? `Staying ${stayingWhen}`
    : `Arriving in ${periodLabel}`;

  return (
    <Card>
      <CardHeader
        title="Bookings"
        subtitle="Find a booking, see where it stands, and take the next step. Payouts and revenue live on the finance screens."
        action={(
          <span className="sv-muted">
            {narrowed ? `${visible.length} of ${rows.length}` : `${rows.length} booking${rows.length === 1 ? '' : 's'}`}
          </span>
        )}
      />

      <div className="sv-bktools">
        {/* ---- which bookings the SERVER selects ---- */}
        <div className="sv-bktools__scope" role="group" aria-label="Which bookings to show">
          <Chip
            pressed={scope === 'month'}
            disabled={pending}
            onClick={() => setScope('month')}
          >
            Arriving in {periodLabel}
          </Chip>
          <Chip
            pressed={scope === 'in-progress'}
            disabled={pending}
            onClick={() => setScope('in-progress')}
          >
            Staying {stayingWhen}
          </Chip>
          {pending ? <span className="sv-muted" role="status">Loading…</span> : null}
        </div>

        {/* ---- narrowing what is already here ---- */}
        <div className="sv-bktools__find">
          <label className="sv-bksearch">
            <span className="sv-bksearch__label">Search bookings</span>
            <input
              type="search"
              className="sv-bksearch__input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Booking, guest, unit or platform"
              autoComplete="off"
            />
          </label>

          {counts.length > 1 ? (
            <div className="sv-bktools__status" role="group" aria-label="Filter by status">
              <Chip pressed={status === 'all'} onClick={() => setStatus('all')}>
                All <span className="sv-chip__count">{rows.length}</span>
              </Chip>
              {counts.map(([value, count]) => (
                <Chip key={value} pressed={status === value} onClick={() => setStatus(value)}>
                  {value} <span className="sv-chip__count">{count}</span>
                </Chip>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {scope === 'in-progress' ? (
        <p className="sv-daynote" role="status">
          Stays covering {isOperationalDay ? 'today' : formatDate(date)}, including bookings
          that began in an earlier month. The reporting month does not apply in this view.
        </p>
      ) : null}

      <CardBody className="sv-card__body--flush">
        {visible.length === 0 ? (
          narrowed ? (
            <EmptyState
              title="No bookings match"
              message="Nothing here matches that search or status. Widen it to see the rest."
              action={<Button variant="secondary" onClick={clear}>Clear search and filters</Button>}
            />
          ) : (
            <EmptyState
              title={scope === 'in-progress' ? 'Nobody is staying' : 'No bookings this month'}
              message={scope === 'in-progress'
                ? `No stay covers ${isOperationalDay ? 'today' : formatDate(date)}. Every unit is between guests.`
                : `No booking arrives in ${periodLabel} with these filters. Try another month, or create the booking.`}
            />
          )
        ) : (
          <DataTable
            columns={columns}
            rows={visible}
            caption={`Bookings — ${scopeLabel}`}
            getRowKey={(r) => r.bookingId}
            mobile="stack"
            sort={sort}
            onSort={onSort}
            emptyTitle="No bookings"
            emptyMessage="Nothing to show."
          />
        )}
      </CardBody>

      {/* Server-resolved, server-projected. The panel is a child, so this component
          holds no opinion about what a booking may disclose. */}
      {detail}
    </Card>
  );
}

/**
 * ONE action per row: the booking's legal next transition, and nothing competing with
 * it. Everything else a booking can do — edit, change dates, cancel, no-show, confirm —
 * lives in the detail panel, reached by the booking reference on the same row.
 *
 * Cancel used to sit here as a second button. It moved rather than disappeared: the
 * replacement was built and proven before the escape hatch was taken away.
 *
 * The SERVER re-checks every transition on submit; this only keeps dead buttons off a
 * busy list.
 */
function BookingRowAction({ row, checkInFields, checkOutFields }: {
  row: OperationalReservationRow;
  checkInFields: FieldSpec[];
  checkOutFields: FieldSpec[];
}) {
  const base = `/api/reservations/${row.bookingId}`;
  const next = primaryAction(row.bookingStatus);

  return (
    <span className="sv-bkactions">
      {next === 'check-in' ? (
        <RowActionButton
          label="Check in" variant="primary" size="md" surface="drawer"
          endpoint={`${base}/check-in`}
          confirmTitle={`Check in ${row.guestDisplayName}`}
          fields={checkInFields}
          context={<StayFacts row={row} />}
          successTemplate={`${row.guestDisplayName} is checked in.`}
        />
      ) : next === 'check-out' ? (
        <RowActionButton
          label="Check out" variant="primary" size="md" surface="drawer"
          endpoint={`${base}/check-out`}
          confirmTitle={`Check out ${row.guestDisplayName}`}
          fields={checkOutFields}
          context={<StayFacts row={row} />}
          successTemplate={`${row.guestDisplayName} is checked out — the unit needs a turnover.`}
        />
      ) : (
        /* Nothing to do here, said plainly rather than left as an empty cell. */
        <span className="sv-bkactions__resting">{restingLabel(row.bookingStatus)}</span>
      )}
    </span>
  );
}

/** The booking, in front of the person, before they commit. Never a figure. */
function StayFacts({ row }: { row: OperationalReservationRow }) {
  return (
    <dl className="sv-facts">
      <div><dt>Guest</dt><dd>{row.guestDisplayName}</dd></div>
      <div><dt>Unit</dt><dd>{row.propertyId}</dd></div>
      <div><dt>Booking</dt><dd className="numeric">{row.bookingId}</dd></div>
      <div><dt>Stay</dt><dd>{formatDateShort(row.checkIn)} → {formatDateShort(row.checkOut)}</dd></div>
      <div><dt>Nights</dt><dd>{row.nights}</dd></div>
      <div><dt>Booked via</dt><dd>{row.platform}</dd></div>
    </dl>
  );
}
