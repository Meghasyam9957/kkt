/**
 * STOCK RECONCILIATION — where the workbook and the movement record disagree.
 *
 * IT COMPARES SUMS OF EVENTS AGAINST CUMULATIVE TOTALS. It does not recompute stock, it does
 * not decide who is right, and it repairs nothing. Opening this page writes nothing at all.
 *
 * The two disagreements mean opposite things and are named separately for that reason:
 *
 *   the workbook moved more than we can explain   ordinary. Everything predating this
 *                                                 feature looks like this, and so does any
 *                                                 edit made in the sheet itself.
 *   we recorded more than the workbook took       a write did not land. Before this record
 *                                                 existed, that loss was undetectable.
 *
 * A screen that merged them into "mismatch" would be telling somebody to investigate the
 * first as though it were the second, which is a week of somebody's life.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { inventoryServiceFor } from '@/lib/server/api/service';
import {
  reconciliationItemView, type ReconciliationView,
} from '@/lib/server/inventory/projections';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';

export const metadata = { title: 'Stock reconciliation — MAKAM Home Stays' };

const STATUS: Record<string, { label: string; tone: Tone; meaning: string }> = {
  MATCHED: {
    label: 'agrees', tone: 'good',
    meaning: 'Every movement we hold is in the workbook’s totals.',
  },
  UNEXPLAINED_MOVEMENT: {
    label: 'workbook ahead', tone: 'neutral',
    meaning: 'The sheet moved by more than we have context for. Ordinary for anything '
      + 'recorded before this existed, or edited in the sheet directly.',
  },
  CONTEXT_AHEAD: {
    label: 'record ahead', tone: 'warn',
    meaning: 'We recorded a movement the totals never took — a write that did not land. '
      + 'Worth a look.',
  },
  UNAPPLIED_CONTEXT: {
    label: 'write failed', tone: 'bad',
    meaning: 'A movement was recorded while the sheet refused it. Nothing claims the stock '
      + 'changed; somebody needs to repair it.',
  },
  STOCK_UNAVAILABLE: {
    label: 'no totals', tone: 'neutral',
    meaning: 'The workbook row carries no Purchased or Used figure to compare against.',
  },
};

export default async function StockReconciliationPage() {
  const access = await checkPageAccess('inventory.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  let rows: ReconciliationView[];
  try {
    rows = (await inventoryServiceFor().reconciliation(access.tenant))
      .map(reconciliationItemView);
  } catch (error) {
    console.error('[inventory] reconciliation failed:', error);
    return (
      <>
        <PageHeader title="Stock reconciliation" description="Where the two records differ." />
        <Section>
          <ErrorState message="We couldn't compare the workbook with the movement record just now." />
        </Section>
      </>
    );
  }

  // Only what differs. A list of everything that already agrees is a list nobody reads.
  const differing = rows.filter((r) => r.status !== 'MATCHED');
  const failedWrites = rows.filter((r) => r.status === 'UNAPPLIED_CONTEXT').length;
  const recordAhead = rows.filter((r) => r.status === 'CONTEXT_AHEAD').length;

  const columns: Column<ReconciliationView>[] = [
    {
      key: 'item', header: 'Item',
      render: (r) => (
        <span>
          <strong>{r.name}</strong>
          <span className="sv-muted"> · <code className="numeric">{r.itemRef}</code></span>
        </span>
      ),
    },
    {
      key: 'purchased', header: 'Purchased — sheet / record', numeric: true,
      render: (r) => (
        <span className="numeric">
          {r.workbookPurchased ?? '—'} / {r.contextPurchased}
        </span>
      ),
    },
    {
      key: 'used', header: 'Used — sheet / record', numeric: true,
      render: (r) => (
        <span className="numeric">{r.workbookUsed ?? '—'} / {r.contextUsed}</span>
      ),
    },
    {
      key: 'status', header: 'Status',
      render: (r) => {
        const meta = STATUS[r.status] ?? { label: r.status, tone: 'neutral' as Tone, meaning: '' };
        return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>;
      },
    },
    {
      key: 'meaning', header: 'What it means',
      render: (r) => <span className="sv-muted">{STATUS[r.status]?.meaning ?? 'Review.'}</span>,
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock reconciliation"
        description="The workbook holds the totals; this holds the events. Where they differ, a person decides."
      />

      <Section>
        <Card>
          <CardHeader title="Across every item" />
          <CardBody>
            <div className="sv-kpi-grid">
              <Count label="Agree" value={rows.length - differing.length} />
              <Count label="Differ" value={differing.length} />
              <Count label="Record ahead" value={recordAhead} tone="warn" />
              <Count label="Write failed" value={failedWrites} tone="bad" />
            </div>
            <p className="sv-kpi__note">
              Compared when this page was opened. Reading it changes nothing in either store —
              this is a comparison, never an authority, and neither side is repaired here.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Where they differ"
            subtitle="An item whose totals already agree is not listed."
          />
          <CardBody>
            <DataTable
              columns={columns}
              rows={differing}
              caption="Items where the workbook and the movement record differ"
              getRowKey={(r) => r.itemRef}
              emptyTitle="Everything agrees"
              emptyMessage="Every movement we hold is accounted for in the workbook’s own totals."
            />
          </CardBody>
        </Card>
      </Section>
    </>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="sv-kpi">
      <dt className="sv-kpi__label">{label}</dt>
      <dd className="sv-kpi__value">
        {tone && value > 0 ? <StatusPill tone={tone}>{value}</StatusPill> : value}
      </dd>
    </div>
  );
}
