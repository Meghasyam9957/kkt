/**
 * STOCK — what the workbook says there is, and what moved it.
 *
 * EVERY NUMBER ON THIS PAGE IS THE WORKBOOK'S. `CurrentStock` is a formula in
 * `15_INVENTORY`; nothing here recomputes it, and the status beside it is derived from that
 * figure and the item's own reorder level — the sheet's two numbers, not a third one invented
 * here. A screen that showed its own balance would be the second stock ledger this whole
 * design exists to avoid, and the first anybody would learn of it is a delivery ordered
 * against a number nobody could reproduce.
 *
 * NEGATIVE IS SHOWN, not clamped. A spreadsheet can hold a negative balance — somebody
 * recorded more used than ever arrived — and rendering that as zero would hide a real
 * counting problem behind a tidy number.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { inventoryServiceFor } from '@/lib/server/api/service';
import { stockItemView, type StockItemView } from '@/lib/server/inventory/projections';
import { inventoryPageContext } from '@/lib/server/inventory/page-context';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { RecordMovementButton } from '@/components/inventory/RecordMovementButton';

export const metadata = { title: 'Stock — MAKAM Home Stays' };

/** Each status in the words a supervisor would use, and the tone it deserves. */
const STATUS: Record<string, { label: string; tone: Tone }> = {
  IN_STOCK: { label: 'in stock', tone: 'good' },
  LOW_STOCK: { label: 'at or below reorder', tone: 'warn' },
  OUT_OF_STOCK: { label: 'none left', tone: 'bad' },
  NEGATIVE: { label: 'negative — count is wrong', tone: 'bad' },
  UNAVAILABLE: { label: 'no figure', tone: 'neutral' },
};

export default async function StockPage() {
  const access = await checkPageAccess('inventory.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  let rows: StockItemView[];
  let context;
  try {
    const service = inventoryServiceFor();
    [rows, context] = await Promise.all([
      service.stock(access.tenant).then((items) => items.map(stockItemView)),
      inventoryPageContext(access.tenant, access.session.role),
    ]);
  } catch (error) {
    console.error('[inventory] stock failed:', error);
    return (
      <>
        <PageHeader title="Stock" description="What the workbook says there is." />
        <Section>
          <ErrorState message="We couldn't read the stock register just now. Try again in a moment." />
        </Section>
      </>
    );
  }

  const needsOrdering = rows.filter(
    (r) => r.status === 'LOW_STOCK' || r.status === 'OUT_OF_STOCK' || r.status === 'NEGATIVE',
  );
  const unnamedVendor = rows.filter((r) => r.vendorName !== null && !r.vendorLinked);

  const columns: Column<StockItemView>[] = [
    {
      key: 'item', header: 'Item',
      render: (r) => (
        <span>
          <strong>{r.name}</strong>
          <span className="sv-muted"> · <code className="numeric">{r.itemRef}</code></span>
        </span>
      ),
    },
    { key: 'category', header: 'Category', render: (r) => r.category || '—' },
    {
      key: 'property', header: 'Held at',
      // COMMON is not a unit — it is stock belonging to no single one, which is most of
      // the linen. Saying so is clearer than showing the raw token.
      render: (r) => (r.propertyId === 'COMMON' ? 'Shared' : r.propertyId ?? '—'),
    },
    {
      key: 'onHand', header: 'On hand', numeric: true,
      render: (r) => (r.currentStock === null
        ? <span className="sv-muted">—</span>
        : <span className="numeric">{r.currentStock} {r.unit}</span>),
    },
    {
      key: 'reorder', header: 'Reorder at', numeric: true,
      render: (r) => (r.minStock === null
        ? <span className="sv-muted">not set</span>
        : <span className="numeric">{r.minStock}</span>),
    },
    {
      key: 'status', header: 'Status',
      render: (r) => {
        const meta = STATUS[r.status] ?? { label: r.status, tone: 'neutral' as Tone };
        return <StatusPill tone={meta.tone}>{meta.label}</StatusPill>;
      },
    },
    {
      key: 'vendor', header: 'Vendor',
      render: (r) => {
        if (!r.vendorName) return <span className="sv-muted">none named</span>;
        return (
          <span className="sv-assigned">
            <span className="sv-assigned__name">{r.vendorName}</span>
            {/*
              * WHETHER we know who that name is, never WHICH — an operations screen has no
              * use for a finance identifier, and the answer to "can we order from them" is
              * the whole of what it needs.
              */}
            {r.vendorLinked
              ? <StatusPill tone="good">known to finance</StatusPill>
              : <span className="sv-muted">a name only</span>}
          </span>
        );
      },
    },
    {
      key: 'action', header: 'What moved',
      render: (r) => (
        <RecordMovementButton
          itemRef={r.itemRef}
          itemName={r.name}
          onHand={r.currentStock}
          unit={r.unit}
          context={context}
        />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Stock"
        description="The workbook owns how much there is. This owns why it moved."
      />

      <Section>
        <Card>
          <CardHeader title="Across the business" />
          <CardBody>
            <div className="sv-kpi-grid">
              <Count label="Items tracked" value={rows.length} />
              <Count label="At or below reorder" value={needsOrdering.length} tone="warn" />
              <Count
                label="Vendor not identified"
                value={unnamedVendor.length}
                tone={unnamedVendor.length > 0 ? 'warn' : 'neutral'}
              />
            </div>
            <p className="sv-kpi__note">
              Read from <code>15_INVENTORY</code> when this page was opened. Nothing here is
              stored, cached or recalculated — the sheet remains the only stock ledger.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Every item"
            subtitle="A movement records what happened and why. The workbook recalculates the balance."
          />
          <CardBody>
            <DataTable
              columns={columns}
              rows={rows}
              caption="Stock on hand, by item"
              getRowKey={(r) => r.itemRef}
              emptyTitle="No stock items"
              emptyMessage="15_INVENTORY has no rows in this workbook yet."
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
