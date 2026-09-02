/**
 * LINK A MAINTENANCE TICKET TO AN ASSET.
 *
 * `16_ASSETS` has a `MaintenanceHistory` column and it is free prose — "serviced twice,
 * compressor replaced". That sentence cannot answer the question anybody actually asks about
 * an asset: which of these tickets was about THIS unit, and how many times has it been back.
 *
 * The link lives in the overlay, not in the sheet: the prose stays exactly as the customer
 * wrote it, and the references sit beside it. A ticket reference is validated against the
 * caller's own workbook, so somebody else's ticket is simply not there.
 */
import { RowActionButton } from '@/components/mutations/actions';
import type { InventoryPageContext } from '@/lib/server/inventory/page-context';

export function LinkTicketButton({
  assetRef, assetName, context,
}: {
  assetRef: string;
  assetName: string;
  context: InventoryPageContext;
}) {
  void context;
  return (
    <RowActionButton
      label="Link a ticket"
      endpoint={`/api/inventory/assets/${assetRef}/tickets`}
      method="POST"
      successTemplate="Linked."
      confirmTitle={`A repair to ${assetName}`}
      fields={[
        {
          name: 'ticketRef', label: 'Ticket reference', type: 'text', required: true,
          placeholder: 'MNT-D-0011',
          help: 'The maintenance ticket’s own id, from your workbook.',
        },
        {
          name: 'note', label: 'What was done (optional)', type: 'textarea',
          help: 'Kept with the link. The sheet’s own history column is left exactly as it is.',
        },
      ]}
    />
  );
}
