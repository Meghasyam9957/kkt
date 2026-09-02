/**
 * MOVEMENTS — why the stock figure changed.
 *
 * This is the record `15_INVENTORY` has never been able to hold. The sheet keeps two running
 * totals; it has no row per event, no room for the task, and no room for the reason. Every
 * line below is one event with its context attached.
 *
 * IT IS NOT A BALANCE, and deliberately shows none. Adding these quantities up would produce
 * a second answer to "how much is there", and two answers to that question is the failure
 * this milestone exists to prevent. The balance is on the Stock page, where it comes from the
 * workbook's own formula.
 *
 * NOBODY'S NAME APPEARS HERE. The overlay records which employee made a movement, because a
 * discrepancy is unanswerable without it — but a running list of who used two towels is a
 * staff-monitoring record, and the projection does not emit it. It is available to the people
 * who investigate one movement, not printed beside every one.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { inventoryServiceFor } from '@/lib/server/api/service';
import { movementView, type MovementView } from '@/lib/server/inventory/projections';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatDateShort } from '@/lib/shared/format';

export const metadata = { title: 'Stock movements — MAKAM Home Stays' };

const MOVEMENT: Record<string, { label: string; tone: Tone; direction: string }> = {
  PURCHASE: { label: 'purchase', tone: 'good', direction: 'in' },
  TRANSFER_IN: { label: 'transfer in', tone: 'info', direction: 'in' },
  CONSUMPTION: { label: 'used', tone: 'neutral', direction: 'out' },
  TRANSFER_OUT: { label: 'transfer out', tone: 'info', direction: 'out' },
  WASTAGE: { label: 'wastage', tone: 'warn', direction: 'out' },
  RETURN: { label: 'returned', tone: 'neutral', direction: 'out' },
  ADJUSTMENT: { label: 'correction', tone: 'warn', direction: '±' },
};

export default async function MovementsPage() {
  const access = await checkPageAccess('inventory.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  let rows: MovementView[];
  try {
    rows = (await inventoryServiceFor().movements(access.tenant, { limit: 200 }))
      .map(movementView);
  } catch (error) {
    console.error('[inventory] movements failed:', error);
    return (
      <>
        <PageHeader title="Stock movements" description="Why the figure changed." />
        <Section>
          <ErrorState message="We couldn't read the movement record just now. Try again in a moment." />
        </Section>
      </>
    );
  }

  const unapplied = rows.filter((r) => !r.workbookApplied);

  const columns: Column<MovementView>[] = [
    {
      key: 'when', header: 'When',
      render: (r) => formatDateShort(r.createdAt.slice(0, 10)),
    },
    {
      key: 'item', header: 'Item',
      render: (r) => <code className="numeric">{r.itemRef}</code>,
    },
    {
      key: 'what', header: 'What happened',
      render: (r) => {
        const meta = MOVEMENT[r.movementType]
          ?? { label: r.movementType, tone: 'neutral' as Tone, direction: '' };
        return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>;
      },
    },
    {
      key: 'quantity', header: 'How much', numeric: true,
      render: (r) => {
        const meta = MOVEMENT[r.movementType];
        return <span className="numeric">{meta?.direction === 'out' ? '−' : '+'}{r.quantity}</span>;
      },
    },
    {
      key: 'task', header: 'For which work',
      render: (r) => {
        if (!r.taskRef) return <span className="sv-muted">not a task</span>;
        return (
          <span>
            <code className="numeric">{r.taskRef}</code>
            {r.taskType ? <span className="sv-muted"> · {r.taskType.toLowerCase()}</span> : null}
          </span>
        );
      },
    },
    {
      key: 'why', header: 'Why',
      render: (r) => {
        if (r.wastageReason) return r.wastageReason.toLowerCase();
        if (r.counterpartyPropertyId) {
          return <span>with <code className="numeric">{r.counterpartyPropertyId}</code></span>;
        }
        return r.reason ? <span>{r.reason}</span> : <span className="sv-muted">—</span>;
      },
    },
    {
      key: 'applied', header: 'Workbook',
      render: (r) => (r.workbookApplied
        ? <StatusPill tone="good">applied</StatusPill>
        : <StatusPill tone="bad">not applied</StatusPill>),
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock movements"
        description="One line per event, with the context the workbook has no column for."
      />

      {unapplied.length > 0 ? (
        <Section>
          <Card>
            <CardHeader title="Recorded, but the workbook never took it" />
            <CardBody>
              <p className="sv-kpi__note">
                {unapplied.length === 1 ? 'One movement was' : `${unapplied.length} movements were`}{' '}
                recorded while the sheet write failed. Nothing claims the stock changed — the
                figure in <code>15_INVENTORY</code> is still the one it always was, and these
                are here so somebody can repair them rather than lose them.
              </p>
            </CardBody>
          </Card>
        </Section>
      ) : null}

      <Section>
        <Card>
          <CardHeader
            title="Most recent first"
            subtitle="Quantities are per event. They are deliberately not totalled: the balance is the workbook's."
          />
          <CardBody>
            <DataTable
              columns={columns}
              rows={rows}
              caption="Stock movements, most recent first"
              getRowKey={(r) => r.id}
              emptyTitle="Nothing has moved yet"
              emptyMessage="Movements recorded from the Stock page appear here, with who, which task and why."
            />
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
