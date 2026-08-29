'use client';
/**
 * THE DAY CONTROL — which operational day the board is describing.
 *
 * The URL is the store, exactly as the filter bar does it: the server re-reads through
 * the provider for the requested day, so nothing here recomputes a board client-side.
 * The only arithmetic is "the day before" and "the day after", which is why it uses the
 * shared serial helpers rather than Date maths that would drift across time zones.
 *
 * "Today" means the SOURCE's operational day, not the browser's clock — in a demo those
 * differ by a year, and a control that jumped to the laptop's date would land on an empty
 * board and look broken.
 */
import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/primitives';
import { Icon } from '@/components/ui/icons';
import { formatDate } from '@/lib/shared/format';
import { shiftIsoDay } from '@/lib/shared/dates';

export function TodayDateControl({ date, operationalDate }: {
  /** The day currently shown. */
  date: string;
  /** The source's own operational day — where "Today" goes. */
  operationalDate: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const goto = useCallback((next: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === operationalDate) params.delete('date');
    else params.set('date', next);
    const query = params.toString();
    // `scroll: false` keeps the reader's place: stepping through days should not throw
    // them back to the top of the board each time.
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }, [router, pathname, searchParams, operationalDate]);

  const isToday = date === operationalDate;

  return (
    <div className="sv-daynav" role="group" aria-label="Operational day">
      <Button
        variant="secondary"
        className="sv-daynav__step"
        onClick={() => goto(shiftIsoDay(date, -1))}
        aria-label={`Previous day, ${formatDate(shiftIsoDay(date, -1))}`}
      >
        <Icon name="chevronRight" size={16} className="sv-daynav__icon--back" />
        <span className="sv-daynav__step-text">Previous</span>
      </Button>

      <p className="sv-daynav__current">
        <span className="sv-daynav__label">
          {isToday ? 'Today' : 'Showing'}
        </span>
        {/* aria-current marks WHICH day is being shown, for a reader stepping through. */}
        <span className="sv-daynav__date" aria-current="date">{formatDate(date)}</span>
      </p>

      <Button
        variant="secondary"
        className="sv-daynav__step"
        onClick={() => goto(shiftIsoDay(date, 1))}
        aria-label={`Next day, ${formatDate(shiftIsoDay(date, 1))}`}
      >
        <span className="sv-daynav__step-text">Next</span>
        <Icon name="chevronRight" size={16} />
      </Button>

      {/* The way back. Absent when it would do nothing. */}
      {isToday ? null : (
        <Button variant="primary" className="sv-daynav__reset" onClick={() => goto(operationalDate)}>
          Back to today
        </Button>
      )}
    </div>
  );
}
