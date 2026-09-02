/**
 * PROCUREMENT ACTIONS — asking, deciding, ordering, and signing for what arrived.
 *
 * Four buttons, one contract. Each is a `RowActionButton`, so each carries the operation id,
 * the APPLYING phase and the named refusal that every other write in this product carries.
 *
 * THE ONE THING WORTH READING TWICE: none of these buttons decides who may press them. The
 * capability check is on the route and in the handler; separation of duty — whoever asked may
 * not be whoever approves — is in the service, and it refuses even a holder of
 * `procurement.approve` who is deciding their own request. A screen that greyed the button
 * out would be a courtesy, not a control, and the person seeing it would learn nothing about
 * why. The server answers `409 SELF_APPROVAL` with a sentence, which the toast shows.
 */
import { RowActionButton } from '@/components/mutations/actions';
import type { FieldSpec } from '@/components/mutations/MutationForm';
import type { InventoryPageContext } from '@/lib/server/inventory/page-context';

/* ------------------------------------------------------------------ *
 * Ask for stock
 * ------------------------------------------------------------------ */

export function NewRequestButton({ context }: { context: InventoryPageContext }) {
  if (context.items.length === 0) return null;

  const fields: FieldSpec[] = [
    {
      name: 'lines.0.itemRef', label: 'Which item', type: 'select', required: true,
      options: [...context.items],
    },
    {
      name: 'lines.0.quantity', label: 'How many', type: 'number', required: true, min: 0,
    },
    {
      name: 'priority', label: 'How urgent', type: 'select',
      options: [
        { value: 'Low', label: 'Low' }, { value: 'Medium', label: 'Medium' },
        { value: 'High', label: 'High' }, { value: 'Critical', label: 'Critical' },
      ],
      defaultValue: 'Medium',
    },
    {
      name: 'reason', label: 'Why', type: 'textarea',
      help: 'What ran out, and what it is holding up. The person approving this reads it.',
    },
    ...(context.properties.length > 0 ? [{
      name: 'propertyId', label: 'For which property (optional)', type: 'select' as const,
      options: [...context.properties],
    }] : []),
  ];

  return (
    <RowActionButton
      label="Ask for stock"
      endpoint="/api/inventory/requests"
      method="POST"
      successTemplate="Requested."
      fields={fields}
      confirmTitle="Ask for stock"
      variant="primary"
      surface="drawer"
      context={(
        <p className="sv-kpi__note">
          A request is a question, not an order. Nothing is committed and no stock moves until
          somebody approves it and what was ordered actually arrives.
        </p>
      )}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Move a request along
 * ------------------------------------------------------------------ */

export function RequestDecisionButton({
  requestId, next, label, variant = 'secondary',
}: {
  requestId: string;
  /** The status this moves the request TO. The only thing the payload carries. */
  next: 'SUBMITTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  label: string;
  variant?: 'secondary' | 'primary' | 'danger';
}) {
  const asks = next === 'REJECTED' || next === 'CANCELLED';
  return (
    <RowActionButton
      label={label}
      endpoint={`/api/inventory/requests/${requestId}/decision`}
      method="POST"
      successTemplate={`${label}.`}
      variant={variant}
      constants={{ status: next }}
      // A refusal or a cancellation is worth a sentence; an approval speaks for itself.
      {...(asks ? {
        confirmTitle: `${label} this request`,
        fields: [{
          name: 'note', label: 'Why', type: 'textarea' as const,
          help: 'The person who asked sees this.',
        }],
      } : {})}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Raise an order
 * ------------------------------------------------------------------ */

export function NewOrderButton({
  context, requestId, label = 'Raise an order',
}: {
  context: InventoryPageContext;
  /** When present, the order follows an approved request rather than standing alone. */
  requestId?: string;
  label?: string;
}) {
  if (context.vendors.length === 0 || context.items.length === 0) return null;

  const fields: FieldSpec[] = [
    {
      name: 'vendorId', label: 'Vendor', type: 'select', required: true,
      options: [...context.vendors],
      help: 'Finance’s own vendor register. There is no second supplier list.',
    },
    {
      name: 'lines.0.itemRef', label: 'Which item', type: 'select', required: true,
      options: [...context.items],
    },
    { name: 'lines.0.quantity', label: 'How many', type: 'number', required: true, min: 0 },
    ...(context.maySeeMoney ? [{
      name: 'lines.0.expectedUnitPriceMinor', label: 'Agreed unit price', type: 'currency' as const,
      help: 'What was agreed per unit. An expectation on an order — never an amount owed. '
        + 'A bill is raised in finance, by a person, when one arrives.',
    }] : []),
    {
      name: 'expectedDate', label: 'Expected by', type: 'date',
    },
  ];

  return (
    <RowActionButton
      label={label}
      endpoint="/api/inventory/purchase-orders"
      method="POST"
      successTemplate="Order raised."
      fields={fields}
      confirmTitle={requestId ? 'Order against this request' : 'Raise a purchase order'}
      variant="primary"
      surface="drawer"
      {...(requestId ? { constants: { requestId } } : {})}
      context={(
        <p className="sv-kpi__note">
          An order is a promise. No stock moves and no money is owed until a delivery is
          received against it.
        </p>
      )}
    />
  );
}

export function OrderStatusButton({
  poId, next, label, variant = 'secondary',
}: {
  poId: string;
  next: 'SUBMITTED' | 'APPROVED' | 'SENT' | 'CANCELLED';
  label: string;
  variant?: 'secondary' | 'primary' | 'danger';
}) {
  return (
    <RowActionButton
      label={label}
      endpoint={`/api/inventory/purchase-orders/${poId}/status`}
      method="POST"
      successTemplate={`${label}.`}
      variant={variant}
      constants={{ status: next }}
      {...(next === 'CANCELLED' ? { confirmTitle: 'Cancel this order' } : {})}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Sign for what arrived — the ONLY event that increases stock
 * ------------------------------------------------------------------ */

export function ReceiveGoodsButton({
  poId, lines,
}: {
  poId: string;
  lines: readonly { id: string; label: string; ordered: number }[];
}) {
  if (lines.length === 0) return null;

  const fields: FieldSpec[] = [
    {
      name: 'lines.0.poLineId', label: 'Which line', type: 'select', required: true,
      options: lines.map((l) => ({ value: l.id, label: `${l.label} · ${l.ordered} ordered` })),
    },
    {
      name: 'lines.0.receivedQuantity', label: 'How many actually arrived',
      type: 'number', required: true, min: 0,
      help: 'What is in front of you, not what was ordered. Short deliveries are the '
        + 'ordinary case, and this is the number that moves the workbook.',
    },
    {
      name: 'lines.0.condition', label: 'Condition (optional)', type: 'text',
      placeholder: 'Two boxes crushed',
    },
    { name: 'notes', label: 'Notes (optional)', type: 'textarea' },
  ];

  return (
    <RowActionButton
      label="Record a delivery"
      endpoint="/api/inventory/goods-receipts"
      method="POST"
      successTemplate="Delivery recorded."
      fields={fields}
      confirmTitle="What actually arrived"
      variant="primary"
      surface="drawer"
      constants={{ poId }}
      context={(
        <p className="sv-kpi__note">
          This is the only action that increases stock, and it moves the workbook by what you
          enter here. It creates no bill: money owed is a separate claim that finance raises.
        </p>
      )}
    />
  );
}

/* ------------------------------------------------------------------ *
 * Say which vendor a workbook name means
 * ------------------------------------------------------------------ */

export function LinkVendorButton({
  vendorName, context,
}: {
  vendorName: string;
  context: InventoryPageContext;
}) {
  if (context.vendors.length === 0) return null;
  return (
    <RowActionButton
      label="Identify"
      endpoint="/api/inventory/vendor-links"
      method="POST"
      successTemplate="Linked."
      confirmTitle={`Who is “${vendorName}”?`}
      constants={{ vendorName }}
      fields={[{
        name: 'vendorId', label: 'This is', type: 'select', required: true,
        options: [...context.vendors],
        help: 'One name means one vendor. A second meaning is refused, because that is a '
          + 'decision somebody has to make rather than a duplicate to accumulate.',
      }]}
    />
  );
}
