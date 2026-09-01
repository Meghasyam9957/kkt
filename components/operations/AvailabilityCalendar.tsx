'use client';
/**
 * THE AVAILABILITY CALENDAR — which unit is free, on which day.
 *
 * One question, asked without opening ten records: *where can I place this booking?*
 *
 * TWO PRESENTATIONS, ONE DATA SET. The month grid answers it spatially; the day view
 * answers it a day at a time. Both are rendered from the same server-computed cells and
 * only one is ever in the accessibility tree — the other is `display:none`, which removes
 * it from the tab order and from screen readers alike. A 31-column grid squeezed onto a
 * phone is not a calendar, it is a rumour of one.
 *
 * NOTHING IS COMPUTED HERE. Occupancy, bars and clipping all arrive decided by
 * `WorkbookViews.calendar`, which uses the same half-open interval every other occupancy
 * figure uses. A calendar that recomputed availability client-side would be a second
 * answer to a question that already has one.
 *
 * No money: the rows are booking identity, dates and status. There is no configuration of
 * this screen in which a figure appears.
 */
import { useCallback, useEffect, useRef } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Card, CardHeader, CardBody, StatusPill, Button, EmptyState } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { TableScroller } from '@/components/ui/primitives';
import { formatDate, formatDateShort, formatMonthLong } from '@/lib/shared/format';
import { bookingStatusTone } from '@/lib/shared/booking-status';
import { BOOKING_PARAM } from './BookingDetailDrawer';
import type {
  CalendarView, CalendarUnitRow, CalendarStay, CalendarDayState,
} from '@/lib/data/providers/types';

/** Sunday-first initials, matching `weekdayOf`. */
const WEEKDAY = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const WEEKDAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** What each state is called, in words. Colour is never the only signal. */
const STATE_LABEL: Record<CalendarDayState, string> = {
  'available': 'Available',
  'booked': 'Booked',
  'checked-in': 'In house',
  'checked-out': 'Stayed',
};

export interface AvailabilityCalendarProps {
  view: CalendarView;
  /** The detail panel for `?booking=`, resolved and projected on the server. */
  detail?: React.ReactNode;
}

export function AvailabilityCalendar({ view, detail }: AvailabilityCalendarProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /** A URL with one parameter changed and everything else the reader set kept. */
  const withParams = useCallback((changes: Record<string, string | null>): string => {
    const params = new URLSearchParams(searchParams.toString());
    for (const [key, value] of Object.entries(changes)) {
      if (value === null) params.delete(key);
      else params.set(key, value);
    }
    const search = params.toString();
    return search ? `${pathname}?${search}` : pathname;
  }, [pathname, searchParams]);

  const goToMonth = useCallback((month: string) => {
    // The selected day belongs to the month it was chosen in; carrying it into another
    // month would leave the day view pointing at a date this grid does not show.
    router.replace(withParams({ month, date: null }), { scroll: false });
  }, [router, withParams]);

  const selectDay = useCallback((date: string) => {
    router.replace(withParams({ date }), { scroll: false });
  }, [router, withParams]);

  /** Where "place a booking here" goes: the workspace, narrowed to that unit and month. */
  const placeHref = (propertyId: string): string =>
    `/admin/operations/reservations?month=${view.month}&property=${propertyId}`;

  /** The booking's own address — the SAME detail panel the Bookings workspace opens. */
  const bookingHref = (bookingId: string): string => withParams({ [BOOKING_PARAM]: bookingId });

  const selectedIndex = view.days.indexOf(view.selectedDate);

  return (
    <Card>
      <CardHeader
        title="Availability"
        subtitle="Which unit is free, and when. Open a booking to act on it, or pick a free day to place one."
        action={<span className="sv-muted">{view.units.length} unit{view.units.length === 1 ? '' : 's'}</span>}
      />

      {/* ---------- the period ---------- */}
      <div className="sv-calnav" role="group" aria-label="Calendar month">
        <Button
          variant="secondary"
          className="sv-calnav__step"
          onClick={() => goToMonth(view.previousMonth)}
          aria-label={`Previous month, ${formatMonthLong(view.previousMonth)}`}
        >
          <Icon name="chevronRight" size={16} className="sv-calnav__icon--back" />
          <span className="sv-calnav__step-text">Previous</span>
        </Button>

        <p className="sv-calnav__current">
          <span className="sv-calnav__label">{view.operationalMonth ? 'This month' : 'Showing'}</span>
          <span className="sv-calnav__month" aria-current="date">{formatMonthLong(view.month)}</span>
        </p>

        <Button
          variant="secondary"
          className="sv-calnav__step"
          onClick={() => goToMonth(view.nextMonth)}
          aria-label={`Next month, ${formatMonthLong(view.nextMonth)}`}
        >
          <span className="sv-calnav__step-text">Next</span>
          <Icon name="chevronRight" size={16} />
        </Button>

        {view.operationalMonth ? null : (
          <Button
            variant="primary"
            className="sv-calnav__reset"
            onClick={() => goToMonth(view.operationalDate.slice(0, 7))}
          >
            Back to this month
          </Button>
        )}
      </div>

      <CardBody className="sv-card__body--flush">
        {view.units.length === 0 ? (
          <EmptyState
            title="No units match this filter"
            message="Clear the property filter to see every unit."
          />
        ) : (
          <>
            <MonthGrid
              view={view}
              bookingHref={bookingHref}
              placeHref={placeHref}
              onSelectDay={selectDay}
            />
            <DayView
              view={view}
              selectedIndex={selectedIndex}
              bookingHref={bookingHref}
              placeHref={placeHref}
              onSelectDay={selectDay}
            />
          </>
        )}
      </CardBody>

      {detail}
    </Card>
  );
}

/* ================================================================== *
 * DESKTOP — a real table: units down, days across
 * ================================================================== */

function MonthGrid({ view, bookingHref, placeHref, onSelectDay }: {
  view: CalendarView;
  bookingHref: (id: string) => string;
  placeHref: (propertyId: string) => string;
  onSelectDay: (date: string) => void;
}) {
  const caption = `Availability by unit for ${formatMonthLong(view.month)}`;
  return (
    <div className="sv-calgrid">
      <TableScroller label={caption}>
        <table className="sv-caltable">
          <caption className="sv-visually-hidden">
            {caption}. Each row is a unit; each column is a day. A booking spans the nights
            it holds — the arrival day counts, the departure day does not.
          </caption>
          <thead>
            <tr>
              <th scope="col" className="sv-caltable__corner">Unit</th>
              {view.days.map((day, i) => {
                const isToday = day === view.operationalDate;
                const isSelected = day === view.selectedDate;
                return (
                  <th
                    key={day}
                    scope="col"
                    className={[
                      'sv-caltable__day',
                      isToday ? 'sv-caltable__day--today' : '',
                      isSelected ? 'sv-caltable__day--selected' : '',
                    ].filter(Boolean).join(' ')}
                    {...(isToday ? { 'aria-current': 'date' as const } : {})}
                  >
                    <button
                      type="button"
                      className="sv-caltable__daybtn"
                      onClick={() => onSelectDay(day)}
                      aria-label={`${formatDate(day)}, ${WEEKDAY_LONG[view.weekdays[i]!]}${isToday ? ' — today' : ''}`}
                    >
                      <span className="sv-caltable__dow" aria-hidden="true">{WEEKDAY[view.weekdays[i]!]}</span>
                      <span className="sv-caltable__dom" aria-hidden="true">{day.slice(8)}</span>
                    </button>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {view.units.map((unit) => (
              <UnitRow
                key={unit.propertyId}
                unit={unit}
                view={view}
                bookingHref={bookingHref}
                placeHref={placeHref}
              />
            ))}
          </tbody>
        </table>
      </TableScroller>
    </div>
  );
}

function UnitRow({ unit, view, bookingHref, placeHref }: {
  unit: CalendarUnitRow;
  view: CalendarView;
  bookingHref: (id: string) => string;
  placeHref: (propertyId: string) => string;
}) {
  /* Walk the cells once: a run held by one booking becomes a single spanning cell, and a
     free day becomes its own. Built from `stays`, which the server derived from the very
     cells it painted — so a bar can never claim a day the grid shows free. */
  const byStart = new Map(unit.stays.map((s) => [s.fromDate, s]));
  const cells: React.ReactNode[] = [];

  for (let i = 0; i < unit.cells.length; i += 1) {
    const cell = unit.cells[i]!;
    const stay = byStart.get(cell.date);
    if (stay) {
      cells.push(
        <td key={cell.date} colSpan={stay.span} className="sv-caltable__cell sv-caltable__cell--stay">
          <StayBar stay={stay} unit={unit} href={bookingHref(stay.bookingId)} />
        </td>,
      );
      i += stay.span - 1;
      continue;
    }
    cells.push(
      <td
        key={cell.date}
        className={[
          'sv-caltable__cell',
          'sv-caltable__cell--free',
          cell.date === view.selectedDate ? 'sv-caltable__cell--selected' : '',
        ].filter(Boolean).join(' ')}
      >
        {/* The aria-label IS the accessible name; a visually-hidden child would be
            redundant text, and an absolutely-positioned one inside a scroller is how
            this screen first learned to scroll the page sideways. */}
        <Link
          className="sv-calfree"
          href={placeHref(unit.propertyId)}
          aria-label={`${unit.unitName} is available on ${formatDate(cell.date)} — open bookings for this unit`}
        />
      </td>,
    );
  }

  return (
    <tr>
      <th scope="row" className="sv-caltable__unit">
        <span className="sv-caltable__unitname">{unit.unitName || unit.propertyId}</span>
        <span className="sv-caltable__unitid numeric">{unit.propertyId}</span>
        {unit.outOfService ? (
          <span className="sv-caltable__oos" title="Standing status on the property master">
            {unit.propertyStatus}
          </span>
        ) : null}
      </th>
      {cells}
    </tr>
  );
}

/**
 * One booking, as a bar.
 *
 * The accessible name carries everything the bar cannot fit — a two-night stay is about
 * 56px wide — so a keyboard or screen-reader user gets the whole booking without needing
 * the pixels. The status is repeated as a word wherever the bar is wide enough, because
 * colour alone never states a status in this product.
 */
function StayBar({ stay, unit, href }: { stay: CalendarStay; unit: CalendarUnitRow; href: string }) {
  const nights = `${stay.nights} night${stay.nights === 1 ? '' : 's'}`;
  const span = stay.checkIn && stay.checkOut
    ? `${formatDateShort(stay.checkIn)} to ${formatDateShort(stay.checkOut)}`
    : nights;
  const clipped = stay.continuesBefore || stay.continuesAfter
    ? ' This stay continues outside the month shown.'
    : '';

  return (
    <Link
      className={[
        'sv-calbar',
        `sv-calbar--${statusModifier(stay.bookingStatus)}`,
        stay.continuesBefore ? 'sv-calbar--from-before' : '',
        stay.continuesAfter ? 'sv-calbar--into-after' : '',
      ].filter(Boolean).join(' ')}
      href={href}
      scroll={false}
      aria-label={
        `${stay.guestDisplayName}, ${stay.bookingId}, ${unit.unitName || unit.propertyId}. `
        + `${span}, ${nights}. ${stay.bookingStatus}. Booked via ${stay.platform}.${clipped}`
      }
    >
      <span className="sv-calbar__guest">{stay.guestDisplayName}</span>
      {stay.span >= 3 ? (
        <span className="sv-calbar__status">{stay.bookingStatus}</span>
      ) : null}
    </Link>
  );
}

/** A CSS-safe modifier for a status that contains a space. */
function statusModifier(status: string): string {
  return status.toLowerCase().replace(/[^a-z]+/g, '-');
}

/* ================================================================== *
 * MOBILE — a day strip, then that day's units
 * ================================================================== */

function DayView({ view, selectedIndex, bookingHref, placeHref, onSelectDay }: {
  view: CalendarView;
  selectedIndex: number;
  bookingHref: (id: string) => string;
  placeHref: (propertyId: string) => string;
  onSelectDay: (date: string) => void;
}) {
  /*
   * When the reader has browsed to a month the selected day is not in, the strip opens
   * on the first of that month rather than pretending a day is selected somewhere else.
   */
  const index = selectedIndex >= 0 ? selectedIndex : 0;
  const day = view.days[index]!;

  const strip = useRef<HTMLDivElement>(null);
  const selected = useRef<HTMLButtonElement>(null);

  /*
   * Bring the selected day into the strip. A month is wider than a phone, so without
   * this the strip opens at the 1st while the list below describes the 19th — the two
   * halves of the screen disagreeing about which day it is.
   *
   * `scrollLeft` rather than `scrollIntoView`: the latter can scroll the PAGE as well as
   * the strip, which on a phone yanks the reader away from what they were looking at.
   * Instant, so there is no motion to respect or to hijack.
   */
  useEffect(() => {
    const container = strip.current;
    const pip = selected.current;
    if (!container || !pip) return;
    container.scrollLeft = pip.offsetLeft - (container.clientWidth - pip.offsetWidth) / 2;
  }, [index, view.month]);

  return (
    <div className="sv-calday">
      <div ref={strip} className="sv-calday__strip" role="group" aria-label={`Days in ${formatMonthLong(view.month)}`}>
        {view.days.map((date, i) => {
          const isToday = date === view.operationalDate;
          const isSelected = i === index;
          return (
            <button
              key={date}
              type="button"
              {...(isSelected ? { ref: selected } : {})}
              className={[
                'sv-calday__pip',
                isSelected ? 'sv-calday__pip--selected' : '',
                isToday ? 'sv-calday__pip--today' : '',
              ].filter(Boolean).join(' ')}
              aria-pressed={isSelected}
              aria-label={`${formatDate(date)}, ${WEEKDAY_LONG[view.weekdays[i]!]}${isToday ? ' — today' : ''}`}
              onClick={() => onSelectDay(date)}
            >
              <span className="sv-calday__dow" aria-hidden="true">{WEEKDAY[view.weekdays[i]!]}</span>
              <span className="sv-calday__dom" aria-hidden="true">{date.slice(8)}</span>
            </button>
          );
        })}
      </div>

      <p className="sv-calday__heading" role="status">
        {formatDate(day)}{day === view.operationalDate ? ' — today' : ''}
      </p>

      <ul className="sv-callist">
        {view.units.map((unit) => {
          const cell = unit.cells[index]!;
          const stay = cell.bookingId
            ? unit.stays.find((s) => s.bookingId === cell.bookingId) ?? null
            : null;
          return (
            <li key={unit.propertyId} className="sv-calrow">
              <div className="sv-calrow__unit">
                <p className="sv-calrow__name">{unit.unitName || unit.propertyId}</p>
                <p className="sv-calrow__meta">
                  <span className="numeric">{unit.propertyId}</span>
                  {unit.outOfService ? ` · ${unit.propertyStatus}` : ''}
                </p>
              </div>

              <div className="sv-calrow__state">
                <StatusPill tone={stay ? bookingStatusTone(stay.bookingStatus) : 'good'}>
                  {stay ? STATE_LABEL[cell.state] : STATE_LABEL.available}
                </StatusPill>
              </div>

              <div className="sv-calrow__action">
                {stay ? (
                  <Link
                    className="sv-btn sv-btn--secondary"
                    href={bookingHref(stay.bookingId)}
                    scroll={false}
                    aria-label={
                      `Open ${stay.guestDisplayName}, ${stay.bookingId}, in ${unit.unitName || unit.propertyId}. `
                      + `${stay.nights} night${stay.nights === 1 ? '' : 's'}. ${stay.bookingStatus}.`
                    }
                  >
                    {stay.guestDisplayName}
                  </Link>
                ) : (
                  <Link
                    className="sv-btn sv-btn--primary"
                    href={placeHref(unit.propertyId)}
                    aria-label={`${unit.unitName || unit.propertyId} is available on ${formatDate(day)} — open bookings for this unit`}
                  >
                    Place a booking
                  </Link>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
