'use client';
/**
 * THE BOOKING DETAIL — one booking, in full, over the list.
 *
 * Addressed by `?booking=BK-YYYY-NNNN`, so it is shareable, refreshable, reachable from
 * a pasted link and dismissible with the browser's Back button. The CONTENT is resolved
 * and projected on the server and arrives here as props; this component decides nothing
 * about who may see what. That is the point: a client that never receives a financial
 * field cannot leak one, whatever a future edit does to this file.
 *
 * "Not recorded" is a first-class state. A blank damage report is a check nobody made,
 * and rendering it as "No" would turn an absence into a clean bill of health.
 */
import { useCallback } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { Drawer } from '@/components/ui/overlay';
import { StatusPill, EmptyState } from '@/components/ui/primitives';
import { formatDate, formatDateShort } from '@/lib/shared/format';
import { bookingStatusTone } from '@/lib/shared/booking-status';
import type { OperationalBookingDetail } from '@/lib/data/views/role-projections';

/** The search param that opens this panel. Exported so the list and the tests agree. */
export const BOOKING_PARAM = 'booking';

export function BookingDetailDrawer({ detail, requestedId, actions }: {
  /** Server-projected. Null when `requestedId` names no booking the source holds. */
  detail: OperationalBookingDetail | null;
  /** What the URL asked for. Absent means the drawer is closed. */
  requestedId?: string;
  /** Lifecycle controls, built on the server from the contract's own field specs. */
  actions?: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  /*
   * REPLACE, not back(). Closing must land on the list whether the reader opened the
   * drawer from it or arrived on a pasted link — `back()` would walk a direct visitor
   * out of the application entirely. Opening uses a Link (a push), so the browser's own
   * Back button still closes the drawer, which is the behaviour people actually try.
   */
  const close = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete(BOOKING_PARAM);
    const search = params.toString();
    router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  if (!requestedId) return null;

  if (!detail) {
    return (
      <Drawer open onClose={close} title="Booking not found">
        <EmptyState
          title={`No booking ${requestedId}`}
          message="Nothing in the workbook carries that reference. Check the booking ID, or close this panel and search the list."
        />
      </Drawer>
    );
  }

  return (
    <Drawer open onClose={close} title={`${detail.guestDisplayName} · ${detail.bookingId}`} wide>
      <div className="sv-bkdetail">
        <StayBanner detail={detail} />

        <Section title="Booking">
          <Fact label="Reference" value={detail.bookingId} mono />
          <Fact label="Platform" value={detail.platform} />
          <Fact label="Platform reference" value={detail.platformRef} mono />
          <Fact label="Booked on" value={detail.bookedOn ? formatDate(detail.bookedOn) : null} />
          <div className="sv-bkdetail__fact">
            <dt>Status</dt>
            <dd>
              <StatusPill tone={bookingStatusTone(detail.bookingStatus)}>
                {detail.bookingStatus}
              </StatusPill>
            </dd>
          </div>
        </Section>

        <Section title="Guest">
          {/* The minimised name, exactly as every list shows it. No full name and no
              contact detail exists on this payload to render. */}
          <Fact label="Name" value={detail.guestDisplayName} />
          <Fact label="Adults" value={String(detail.adults)} />
          <Fact label="Children" value={String(detail.children)} />
          <Fact label="Guests in total" value={String(detail.guests)} />
        </Section>

        <Section title="Stay">
          <Fact label="Unit" value={detail.unitName || detail.propertyId} />
          <Fact label="Unit ID" value={detail.propertyId} mono />
          <Fact label="Check-in" value={detail.checkIn ? formatDate(detail.checkIn) : null} />
          <Fact label="Check-out" value={detail.checkOut ? formatDate(detail.checkOut) : null} />
          <Fact label="Nights" value={String(detail.nights)} />
          {/* Written by the check-in and check-out mutations, and shown here for the
              first time — the times used to go into the workbook and out of sight. */}
          <Fact label="Arrived at" value={detail.checkInTime} />
          <Fact label="Departed at" value={detail.checkOutTime} />
          <Flag label="Early check-in" value={detail.earlyCheckIn} />
          <Flag label="Late checkout" value={detail.lateCheckout} />
        </Section>

        <Section title="Operations">
          <Fact label="Guest verification" value={detail.guestVerification} />
          <Fact label="Damage report" value={detail.damageReport} />
          <Flag label="Maintenance required" value={detail.maintenanceRequired} />
          <Fact label="Notes" value={detail.notes} />
        </Section>

        {/*
          * THE UNIT, not the stay.
          *
          * 13_HOUSEKEEPING has a BookingID column, but nothing validates it, nothing
          * makes it unique and every seeded turnover leaves it empty — so there is no
          * relationship to report, and this section says whose state it is describing in
          * its own title. UI-8 audited that and declined to fabricate the join; see
          * docs/UI8_TURNOVER_DECISIONS.md.
          */}
        <Section title="This unit, right now">
          <Fact label="Turnover" value={detail.unitState.housekeeping} />
          <Fact label="Inspection" value={detail.unitState.housekeepingInspection} />
          <Fact label="Turnover assigned to" value={detail.unitState.housekeepingCleaner} />
          <div className="sv-bkdetail__fact">
            <dt>Open maintenance</dt>
            <dd>
              {detail.unitState.openMaintenance === 0
                ? 'None open'
                : `${detail.unitState.openMaintenance} open`}
              {detail.unitState.maintenancePriority
                ? ` · ${detail.unitState.maintenancePriority} priority`
                : ''}
            </dd>
          </div>
          <Fact label="Most pressing" value={detail.unitState.maintenanceHeadline} />
        </Section>

        {actions ? (
          <section className="sv-bkdetail__section">
            <h3 className="sv-bkdetail__heading">Actions</h3>
            <div className="sv-bkdetail__actions">{actions}</div>
          </section>
        ) : null}
      </div>
    </Drawer>
  );
}

/**
 * WHERE THE STAY IS, in the words a front desk uses.
 *
 * A presentation of the booking's EXISTING status — no new state vocabulary. "Checked In"
 * is the workbook's word and stays in the Booking section beside the reference; "In
 * house" is what the person at the desk says about the same fact, and it is what they
 * need to read first.
 *
 * The sentence beneath is assembled only from what is actually recorded. An arrival with
 * no time says so rather than inventing one, because "arrived" without a time is still
 * true and "arrived at —" is not a sentence.
 */
const STAY_HEADLINE: Record<string, string> = {
  'Inquiry': 'Enquiry',
  'Confirmed': 'Arriving',
  'Checked In': 'In house',
  'Checked Out': 'Stay complete',
  'Cancelled': 'Cancelled',
  'No Show': 'Did not arrive',
};

/** A CSS-safe modifier for a status that contains a space. */
function statusModifier(status: string): string {
  return status.toLowerCase().replace(/[^a-z]+/g, '-');
}

function StayBanner({ detail }: { detail: OperationalBookingDetail }) {
  const unit = detail.unitName || detail.propertyId;
  const nights = `${detail.nights} night${detail.nights === 1 ? '' : 's'}`;
  const span = detail.checkIn && detail.checkOut
    ? `${formatDateShort(detail.checkIn)} to ${formatDateShort(detail.checkOut)}`
    : null;

  let line: string;
  switch (detail.bookingStatus) {
    case 'Checked In':
      line = detail.checkInTime
        ? `Arrived at ${detail.checkInTime}. Departs ${detail.checkOut ? formatDate(detail.checkOut) : 'on a date not recorded'}.`
        : `Arrival time not recorded. Departs ${detail.checkOut ? formatDate(detail.checkOut) : 'on a date not recorded'}.`;
      break;
    case 'Checked Out':
      line = detail.checkOutTime
        ? `Departed at ${detail.checkOutTime}. ${nights} in ${unit}.`
        : `Departure time not recorded. ${nights} in ${unit}.`;
      break;
    default:
      line = span ? `${nights} in ${unit}, ${span}.` : `${nights} in ${unit}.`;
  }

  return (
    <p className={`sv-stay sv-stay--${statusModifier(detail.bookingStatus)} m-reveal`}>
      <span className="sv-stay__state">
        {STAY_HEADLINE[detail.bookingStatus] ?? detail.bookingStatus}
      </span>
      <span className="sv-stay__line">{line}</span>
    </p>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="sv-bkdetail__section">
      <h3 className="sv-bkdetail__heading">{title}</h3>
      <dl className="sv-bkdetail__facts">{children}</dl>
    </section>
  );
}

/**
 * One fact. An empty or null value renders NOT RECORDED rather than a blank cell — a
 * blank reads as "nothing to say here", which is a claim the workbook has not made.
 */
function Fact({ label, value, mono = false }: {
  label: string; value: string | null | undefined; mono?: boolean;
}) {
  const recorded = value !== null && value !== undefined && value !== '';
  return (
    <div className="sv-bkdetail__fact">
      <dt>{label}</dt>
      <dd className={recorded ? (mono ? 'numeric' : '') : 'sv-bkdetail__unset'}>
        {recorded ? value : 'Not recorded'}
      </dd>
    </div>
  );
}

/**
 * A checkbox column, in three states rather than two.
 *
 * `null` is not `false`. "Maintenance required: No" says somebody inspected the unit and
 * found nothing; "Not recorded" says nobody looked. Collapsing them would let an
 * unchecked room read as a checked one.
 */
function Flag({ label, value }: { label: string; value: boolean | null }) {
  return (
    <div className="sv-bkdetail__fact">
      <dt>{label}</dt>
      <dd className={value === null ? 'sv-bkdetail__unset' : ''}>
        {value === null ? 'Not recorded' : value ? 'Yes' : 'No'}
      </dd>
    </div>
  );
}
