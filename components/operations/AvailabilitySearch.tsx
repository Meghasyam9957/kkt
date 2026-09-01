'use client';
/**
 * AVAILABILITY SEARCH — the front desk's own question, asked in its own words.
 *
 *   WHEN?  WHERE?  HOW MANY?  →  WHAT IS FREE?
 *
 * A form and a list, not a grid: the calendar answers "what is happening in March", this
 * answers "I have a guest on the phone for the 12th to the 15th". They are two views of
 * one set of bookings and neither computes availability — `WorkbookViews.availability`
 * does, from the same half-open interval every occupancy figure in the product uses.
 *
 * NOTHING IS COMPUTED HERE. Free/held, the conflicts, the nights, even the dates the
 * empty form offers all arrive decided. The only state this component holds is what the
 * reader has typed but not yet asked for.
 *
 * NO PRICE, anywhere. Availability is availability; a rate would be a business milestone
 * this product has not reached, and no field for one exists on the view.
 *
 * NO SECOND BOOKING FORM. Choosing a unit opens the SAME `NewRecordButton` over the same
 * `reservationFields` and the same `/api/reservations` the Bookings workspace uses, with
 * the search's own context filled in. A form that "just" repeated three fields here would
 * be the second place a booking can be created, and the first thing to drift.
 */
import { useCallback, useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  Card, CardHeader, CardBody, Button, StatusPill,
} from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { NewRecordButton } from '@/components/mutations/actions';
import type { FieldSpec } from '@/components/mutations/MutationForm';
import { formatDate, formatDateShort } from '@/lib/shared/format';
import { bookingStatusTone } from '@/lib/shared/booking-status';
import type {
  AvailabilitySearchView, AvailabilityUnit, AvailabilityConflict, AvailabilityField,
} from '@/lib/data/providers/types';

export interface AvailabilitySearchProps {
  view: AvailabilitySearchView;
  /**
   * THE booking creation fields, built on the server from the V1 contract by
   * `reservationFields(..., { withValues: false })` — the same call the Bookings
   * workspace makes. No money field is in this array, so none can be filled in here.
   */
  bookingFields: FieldSpec[];
}

/** Where the calendar shows the same range. Context travels; date state does not. */
function calendarHref(view: AvailabilitySearchView, propertyId?: string): string {
  const day = view.checkIn ?? view.defaultCheckIn;
  const params = new URLSearchParams({ month: day.slice(0, 7), date: day });
  const property = propertyId ?? view.propertyId;
  if (property) params.set('property', property);
  return `/admin/operations/calendar?${params.toString()}`;
}

/**
 * The canonical field specs with this search's answers already in them.
 *
 * A copy of the spec objects with `defaultValue` set — never a new field, never a field
 * removed. Anything the server did not offer (every money field) cannot appear, because
 * this only ever rewrites specs that are already in the array.
 */
function prefilled(fields: FieldSpec[], values: Record<string, string>): FieldSpec[] {
  return fields.map((field) => (
    values[field.name] === undefined ? field : { ...field, defaultValue: values[field.name]! }
  ));
}

export function AvailabilitySearch({ view, bookingFields }: AvailabilitySearchProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [pending, startTransition] = useTransition();

  /* Seeded from what was ASKED, not from what was accepted: a rejected date has to stay
     on screen to be corrected. Empty (a first visit) falls back to the offered range. */
  const [checkIn, setCheckIn] = useState(view.asked.checkIn || view.defaultCheckIn);
  const [checkOut, setCheckOut] = useState(view.asked.checkOut || view.defaultCheckOut);
  const [property, setProperty] = useState(view.propertyId ?? '');
  const [guests, setGuests] = useState(view.asked.guests);
  /** Which result's booking form is open — a list of near-identical units needs it said. */
  const [selected, setSelected] = useState<string | null>(null);

  const problemFor = useCallback((field: AvailabilityField): string | null =>
    view.problems.find((p) => p.field === field)?.message ?? null, [view.problems]);

  const search = useCallback((event: React.FormEvent) => {
    event.preventDefault();
    const params = new URLSearchParams();
    params.set('checkin', checkIn);
    params.set('checkout', checkOut);
    if (property) params.set('property', property);
    if (guests) params.set('guests', guests);
    // The URL IS the search. Nothing is held here that a shared link would lose.
    startTransition(() => router.push(`${pathname}?${params.toString()}`, { scroll: false }));
  }, [router, pathname, checkIn, checkOut, property, guests]);

  /**
   * The answer, in one sentence — the live region a screen reader hears after a search,
   * and the first thing a sighted reader sees. Present on every render so the change is
   * announced rather than the region appearing from nowhere.
   */
  const summary = useMemo((): string => {
    if (view.problems.length > 0) {
      return 'That search could not be run. Correct the highlighted field and try again.';
    }
    if (!view.searched) {
      return 'Choose a check-in and a check-out date. Every unit is checked against the '
        + 'bookings already on the register — the arrival day counts, the departure day '
        + 'does not.';
    }
    const total = view.available.length + view.unavailable.length;
    const nights = `${view.nights} night${view.nights === 1 ? '' : 's'}`;
    const party = view.guests === null ? '' : ` for ${view.guests} guest${view.guests === 1 ? '' : 's'}`;
    const range = `${formatDateShort(view.checkIn!)} to ${formatDateShort(view.checkOut!)}`;
    return view.available.length === 0
      ? `No units are free for ${nights}${party}, ${range}. ${total} checked.`
      : `${view.available.length} of ${total} unit${total === 1 ? '' : 's'} free for ${nights}${party}, ${range}.`;
  }, [view]);

  return (
    <Card>
      <CardHeader
        title="Find a unit"
        subtitle="Which units are free for these dates? Pick one to start the booking."
        action={(
          <Link className="sv-availlink" href={calendarHref(view)}>
            <Icon name="calendar" size={16} />
            View the calendar
          </Link>
        )}
      />

      {/* ---------- WHEN · WHERE · HOW MANY ---------- */}
      <CardBody>
        <form className="sv-availform" onSubmit={search} noValidate>
          <div className="sv-availform__fields">
            <Field
              id="avail-checkin"
              label="Check-in"
              hint="Arrival day"
              problem={problemFor('checkIn')}
            >
              {(props) => (
                <input
                  {...props}
                  type="date"
                  className="sv-input"
                  value={checkIn}
                  onChange={(e) => setCheckIn(e.target.value)}
                  required
                />
              )}
            </Field>

            <Field
              id="avail-checkout"
              label="Check-out"
              hint="Departure day — this night is not held"
              problem={problemFor('checkOut')}
            >
              {(props) => (
                <input
                  {...props}
                  type="date"
                  className="sv-input"
                  value={checkOut}
                  /* The browser's own guard against the range this screen rejects. The
                     server still checks: a native `min` is a courtesy, not a control. */
                  min={checkIn || undefined}
                  onChange={(e) => setCheckOut(e.target.value)}
                  required
                />
              )}
            </Field>

            <Field id="avail-property" label="Property" hint="Every unit, or just one">
              {(props) => (
                <select
                  {...props}
                  className="sv-input"
                  value={property}
                  onChange={(e) => setProperty(e.target.value)}
                >
                  <option value="">All properties</option>
                  {view.properties.map((option) => (
                    <option key={option.id} value={option.id}>{option.name}</option>
                  ))}
                </select>
              )}
            </Field>

            <Field
              id="avail-guests"
              label="Guests"
              hint="Leave blank for any size"
              problem={problemFor('guests')}
            >
              {(props) => (
                <input
                  {...props}
                  type="number"
                  inputMode="numeric"
                  className="sv-input"
                  value={guests}
                  min={1}
                  max={20}
                  placeholder="Any"
                  onChange={(e) => setGuests(e.target.value)}
                />
              )}
            </Field>
          </div>

          <div className="sv-availform__go">
            <Button type="submit" variant="primary" disabled={pending}>
              {pending ? 'Searching…' : 'Search availability'}
            </Button>
            <span className="sv-availform__note">
              Up to {view.maxNights} nights at a time. Today is {formatDate(view.operationalDate)}.
            </span>
          </div>
        </form>

        <p className="sv-availsummary" role="status" aria-live="polite">{summary}</p>
      </CardBody>

      {/* ---------- WHAT IS FREE ---------- */}
      {view.searched ? (
        <CardBody className="sv-card__body--flush">
          <Group
            title="Available"
            count={view.available.length}
            empty="Nothing is free for the whole of this range. The units below say who has them."
          >
            {view.available.map((unit) => (
              <UnitCard
                key={unit.propertyId}
                unit={unit}
                view={view}
                selected={selected === unit.propertyId}
                action={(
                  <NewRecordButton
                    label="Select"
                    title={`Place a booking in ${unit.unitName || unit.propertyId}`}
                    endpoint="/api/reservations"
                    /* The canonical specs, carrying what the search already knows. */
                    fields={prefilled(bookingFields, {
                      propertyId: unit.propertyId,
                      checkInDate: view.checkIn!,
                      checkOutDate: view.checkOut!,
                      ...(view.guests === null ? {} : { adults: String(view.guests) }),
                    })}
                    submitLabel="Create booking"
                    successTemplate="{id} created — the workbook calculates the rest."
                    idField="BookingID"
                    wide
                    onOpenChange={(open) => setSelected(open ? unit.propertyId : null)}
                  />
                )}
              />
            ))}
          </Group>

          {view.unavailable.length > 0 ? (
            <Group title="Not available" count={view.unavailable.length} empty="">
              {view.unavailable.map((unit) => (
                <UnitCard key={unit.propertyId} unit={unit} view={view} selected={false} />
              ))}
            </Group>
          ) : null}
        </CardBody>
      ) : null}
    </Card>
  );
}

/* ================================================================== *
 * One labelled control
 * ================================================================== */

/**
 * A real `<label>`, its hint, and the problem the server reported for this field.
 *
 * The input receives `id`, `aria-invalid` and `aria-describedby` from here rather than
 * assembling them at each call site, which is how one of four fields ends up unlabelled.
 */
function Field({ id, label, hint, problem, children }: {
  id: string;
  label: string;
  hint: string;
  problem?: string | null;
  children: (props: {
    id: string; 'aria-invalid'?: true; 'aria-describedby': string;
  }) => React.ReactNode;
}) {
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  return (
    <div className={`sv-field${problem ? ' sv-field--invalid' : ''}`}>
      <label className="sv-field__label" htmlFor={id}>{label}</label>
      {children({
        id,
        ...(problem ? { 'aria-invalid': true as const } : {}),
        'aria-describedby': problem ? `${errorId} ${hintId}` : hintId,
      })}
      <span className="sv-field__help" id={hintId}>{hint}</span>
      {problem ? (
        <span className="sv-field__error" id={errorId} role="alert">
          <Icon name="warning" size={14} />
          {problem}
        </span>
      ) : null}
    </div>
  );
}

/* ================================================================== *
 * Results
 * ================================================================== */

function Group({ title, count, empty, children }: {
  title: string; count: number; empty: string; children: React.ReactNode;
}) {
  return (
    <section className="sv-availgroup" aria-label={`${title} — ${count} unit${count === 1 ? '' : 's'}`}>
      <h3 className="sv-availgroup__title">
        {title}
        <span className="sv-availgroup__count numeric">{count}</span>
      </h3>
      {count === 0
        ? (empty ? <p className="sv-availgroup__empty">{empty}</p> : null)
        : <ul className="sv-availlist">{children}</ul>}
    </section>
  );
}

/**
 * One unit, as a front desk reads it: what it is, how many it sleeps, and either the
 * action or the reason there isn't one.
 *
 * The state is a WORD in a pill, never a colour alone, and the whole card is text — so
 * this list is itself the non-visual alternative the grid needs.
 */
function UnitCard({ unit, view, selected, action }: {
  unit: AvailabilityUnit;
  view: AvailabilitySearchView;
  selected: boolean;
  action?: React.ReactNode;
}) {
  const name = unit.unitName || unit.propertyId;
  const state = unit.available ? 'Available'
    : unit.blocker === 'capacity' ? 'Too small'
    : 'Booked';

  return (
    <li
      className={[
        'sv-availcard',
        unit.available ? 'sv-availcard--free' : 'sv-availcard--held',
        selected ? 'sv-availcard--selected' : '',
      ].filter(Boolean).join(' ')}
      {...(selected ? { 'aria-current': true as const } : {})}
    >
      <div className="sv-availcard__head">
        <div className="sv-availcard__id">
          <p className="sv-availcard__name">{name}</p>
          <p className="sv-availcard__meta">
            <span className="numeric">{unit.propertyId}</span>
            {unit.unitType ? ` · ${unit.unitType}` : ''}
            {` · sleeps ${unit.maxGuests}`}
          </p>
        </div>
        <StatusPill tone={unit.available ? 'good' : 'neutral'}>{state}</StatusPill>
      </div>

      {unit.outOfService ? (
        <p className="sv-availcaution">
          <Icon name="warning" size={14} />
          <span>
            Standing status on the property master is <strong>{unit.propertyStatus}</strong>.
            That flag carries no dates, so it does not decide this range — check before selling.
          </span>
        </p>
      ) : null}

      {unit.blocker === 'capacity' ? (
        <p className="sv-availcard__reason">
          Sleeps {unit.maxGuests}, and {view.guests} {view.guests === 1 ? 'guest was' : 'guests were'} asked for.
        </p>
      ) : null}

      {unit.conflicts.length > 0 ? (
        <ul className="sv-availconflicts">
          {unit.conflicts.map((conflict) => (
            <Conflict key={conflict.bookingId} conflict={conflict} />
          ))}
        </ul>
      ) : null}

      <div className="sv-availcard__actions">
        {action}
        <Link className="sv-availlink" href={calendarHref(view, unit.propertyId)}>
          <Icon name="calendar" size={16} />
          <span>{unit.available ? 'View calendar' : `See ${name} on the calendar`}</span>
        </Link>
      </div>
    </li>
  );
}

/**
 * A booking in the way.
 *
 * Reference, status, platform, dates and the MINIMISED guest name — exactly what the
 * Bookings list already shows this capability, and nothing beyond it. The link opens the
 * booking in the SAME detail panel that register uses.
 */
function Conflict({ conflict }: { conflict: AvailabilityConflict }) {
  const held = conflict.fromDate === conflict.toDate
    ? formatDateShort(conflict.fromDate)
    : `${formatDateShort(conflict.fromDate)} to ${formatDateShort(conflict.toDate)}`;
  const nights = `${conflict.nights} night${conflict.nights === 1 ? '' : 's'}`;

  return (
    <li className="sv-availconflict">
      <StatusPill tone={bookingStatusTone(conflict.bookingStatus)}>
        {conflict.bookingStatus}
      </StatusPill>
      <span className="sv-availconflict__when">
        Held {held} <span className="sv-muted">({nights})</span>
      </span>
      <Link
        className="sv-availconflict__ref numeric"
        href={`/admin/operations/reservations?booking=${conflict.bookingId}`}
        aria-label={
          `Open ${conflict.bookingId}, ${conflict.guestDisplayName}, ${conflict.bookingStatus}, `
          + `booked via ${conflict.platform}. Holds ${held}, ${nights} of the range searched.`
        }
      >
        {conflict.bookingId}
      </Link>
      <span className="sv-availconflict__guest">{conflict.guestDisplayName}</span>
    </li>
  );
}
