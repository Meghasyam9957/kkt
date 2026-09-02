import { redirect } from 'next/navigation';
import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { FinancialReservationsTable } from '@/components/pages/RegisterTables';
import { roleSeesFinancialFigures } from '@/lib/shared/roles';
import { NewRecordButton } from '@/components/mutations/actions';
import { reservationFields } from '@/lib/server/api/form-fields';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { getDataProvider } from '@/lib/data/providers';
import { requireTenantContext } from '@/lib/server/auth/page-guard';

export const metadata = { title: 'Booking Ledger — MAKAM Home Stays' };

/**
 * Create a booking WITH its values.
 *
 * The operations workspace deliberately offers no money fields — a role holding no
 * financial capability does not author a booking's value. But `reservation.update`
 * accepts no rate or fee either, so booking money can only ever be entered at creation:
 * removing it from the operations form without providing it here would have made a
 * booking's value unenterable through the product entirely.
 *
 * So it lives where money lives. Gated on a financial capability, checked on the SERVER
 * — for anyone else this renders nothing at all, and the API guard checks again on
 * submit regardless of what the page chose to draw.
 */
async function NewValuedBookingAction() {
  const access = await checkPageAccess('revenue.read');
  if (!access.allowed) return null;

  const provider = getDataProvider(await requireTenantContext());
  const [propertyIds, platforms] = await Promise.all([
    provider.getPropertyIds(), provider.getPlatforms(),
  ]);
  return (
    <NewRecordButton
      label="+ New Booking"
      title="Create a booking, with its value"
      endpoint="/api/reservations"
      fields={reservationFields(propertyIds, platforms)}
      submitLabel="Create booking"
      successTemplate="{id} created — totals and payout are calculated by the workbook."
      idField="BookingID"
      wide
    />
  );
}

/**
 * THE BOOKING LEDGER — the financial view of the bookings register.
 *
 * The same rows the Bookings workspace works with, read for what they are worth: gross
 * value, expected payout, payout status. The working screen is
 * /admin/operations/reservations; this one is under Finance and is where a booking's
 * value is entered.
 *
 * A role with no financial capability that opens it directly is sent to the workspace,
 * before any booking is read for them. It used to render them the operational
 * projection — which is exactly what the workspace already is, so the two routes were
 * one screen under two names.
 */
export default async function BookingLedgerPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;

  /*
   * A role with no financial capability is sent to the workspace instead — BEFORE any
   * booking is read on their behalf.
   *
   * This screen used to render the operational projection for them: the same component,
   * over the same rows, as the Bookings workspace. Two routes, two menu names, one
   * screen. Redirecting is both the tidier answer and the stricter one — where the
   * projection made sure no financial FIELD reached them, the redirect means no row
   * from this route reaches them at all.
   *
   * The capability that guards the page stays `reservations.read`, because the rows are
   * the same rows; what differs is which presentation of them a role is sent to.
   */
  const access = await checkPageAccess('reservations.read');
  if (access.allowed && !roleSeesFinancialFigures(access.session.role)) {
    const query = new URLSearchParams();
    for (const key of ['month', 'property', 'platform'] as const) {
      if (params[key]) query.set(key, params[key]!);
    }
    const search = query.toString();
    redirect(search
      ? `/admin/operations/reservations?${search}`
      : '/admin/operations/reservations');
  }

  return (
    <ReadOnlyPage
      capability="reservations.read"
      title="Booking Ledger"
      description="What each booking is worth: gross value, expected payout and where the money has got to. Guest names are minimised in this list view — contact details are never shown here."
      searchParams={params}
      fetcher={(provider, filters) => provider.getReservations(filters)}
      actions={<NewValuedBookingAction />}
    >
      {(rows, envelope) => (
        <FinancialReservationsTable rows={rows} period={envelope.meta.period} />
      )}
    </ReadOnlyPage>
  );
}
