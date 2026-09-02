/**
 * RECORD A MOVEMENT — the sentence the workbook cannot say.
 *
 * `15_INVENTORY` has a Purchased column and a Used column and no room for anybody's name, no
 * room for the task, and no room for the reason. It has never been able to answer "who used
 * two towels, and on which turnover" — this action is where that answer is given.
 *
 * Built out of `RowActionButton`, which already runs the write contract every mutation in
 * this product runs: one operation id per opened intent, a visible APPLYING phase, no
 * optimistic state, and a refusal that stays on screen with its code attached.
 *
 * WHY EVERY FIELD BEYOND TYPE AND QUANTITY IS OPTIONAL HERE. The rules about which extra a
 * movement needs — wastage needs a cause, a transfer needs the other property, a correction
 * needs a direction and a reason — live in `InventoryService.recordMovement`, and a second
 * copy of them in the browser is a second thing to keep in step. When something is missing
 * the server answers with a named code and a sentence, which the toast shows; the person
 * then has the words in front of them, which is the right moment to ask.
 */
import { RowActionButton } from '@/components/mutations/actions';
import type { FieldSpec } from '@/components/mutations/MutationForm';
import type { InventoryPageContext } from '@/lib/server/inventory/page-context';

export function RecordMovementButton({
  itemRef, itemName, onHand, unit, context, label = 'Record movement',
}: {
  itemRef: string;
  itemName: string;
  onHand: number | null;
  unit: string;
  context: InventoryPageContext;
  label?: string;
}) {
  const fields: FieldSpec[] = [
    {
      name: 'movementType',
      label: 'What happened',
      type: 'select',
      required: true,
      options: [...context.movementTypes],
      help: 'The type carries the direction. A quantity is always positive.',
    },
    {
      name: 'quantity',
      label: `How many (${unit})`,
      type: 'number',
      required: true,
      min: 0,
      help: 'How much moved — never the new total. The server adds it to what the '
        + 'workbook already says.',
    },
    ...(context.staff.length > 0 ? [{
      name: 'employeeId',
      label: 'Who (optional)',
      type: 'select' as const,
      options: [...context.staff],
      help: 'Recorded against the movement, and never shown on a stock list.',
    }] : []),
    {
      name: 'taskRef',
      label: 'Task reference (optional)',
      type: 'text',
      placeholder: 'HK-2027-0041 or MNT-D-0011',
      help: 'The workbook’s own task or ticket id, when this movement belonged to one.',
    },
    {
      name: 'wastageReason',
      label: 'If wastage, what happened to it',
      type: 'select',
      options: [...context.wastageReasons],
    },
    ...(context.properties.length > 0 ? [{
      name: 'counterpartyPropertyId',
      label: 'If a transfer, the other property',
      type: 'select' as const,
      options: [...context.properties],
    }] : []),
    {
      name: 'reason',
      label: 'Why (required for a correction)',
      type: 'textarea',
      help: 'A correction is the movement nobody can audit later, so it has to say why.',
    },
    ...(context.mayAdjust ? [{
      name: 'adjusts',
      label: 'If a correction, which way',
      type: 'select' as const,
      options: [
        { value: 'PURCHASED', label: 'Adds stock (corrects Purchased)' },
        { value: 'USED', label: 'Removes stock (corrects Used)' },
      ],
      help: 'Guessing this would let a correction mean its opposite, so it is never assumed.',
    }] : []),
  ];

  return (
    <RowActionButton
      label={label}
      endpoint="/api/inventory/movements"
      method="POST"
      successTemplate="Recorded."
      fields={fields}
      confirmTitle={`${itemName} · ${itemRef}`}
      surface="drawer"
      // The item is the ROW's, not the person's — nobody restates what they just clicked.
      constants={{ itemRef }}
      context={(
        <p className="sv-kpi__note">
          The workbook says <strong>{onHand === null ? 'nothing' : `${onHand} ${unit}`}</strong>{' '}
          on hand. That figure stays the workbook’s: this records what moved and why, and the
          sheet recalculates the balance itself.
        </p>
      )}
    />
  );
}
