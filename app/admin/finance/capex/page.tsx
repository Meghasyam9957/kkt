import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import type { CapexRow } from '@/lib/data/providers/types';
import { NewRecordButton } from '@/components/mutations/actions';
import { capexFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';

export const metadata = { title: 'CAPEX — Srivillu Home Stays' };

async function NewCapexAction() {
  const propertyIds = await getDataProvider().getPropertyIds();
  return (
    <NewRecordButton
      label="+ New CAPEX"
      title="Record a CAPEX item"
      endpoint="/api/capex"
      fields={capexFields(propertyIds)}
      submitLabel="Record CAPEX"
      successTemplate="{id} recorded — the line total is calculated by the workbook."
      idField="CapexID"
      wide
    />
  );
}

export default async function CapexPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="capex.read"
      title="CAPEX"
      description="Setup and capital spend for the selected month. CAPEX never enters operating profit — the P&L shows it as a memo line only."
      searchParams={params}
      filters={['month', 'property']}
      fetcher={(provider, f) => provider.getCapex(f)}
      actions={<NewCapexAction />}
    >
      {(rows) => <CapexTable rows={rows} />}
    </ReadOnlyPage>
  );
}

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'neutral'> = {
  Paid: 'good', Pending: 'warn', Partial: 'warn', Failed: 'bad',
};

function CapexTable({ rows }: { rows: CapexRow[] }) {
  const total = rows.reduce((t, r) => t + r.lineTotal, 0);
  const columns: Column<CapexRow>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDateShort(r.date), footer: 'Total' },
    { key: 'id', header: 'CAPEX ID', render: (r) => <code className="numeric">{r.id}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId || '—' },
    {
      key: 'category', header: 'Category',
      render: (r) => (
        <span>
          {r.category}
          {r.item ? <span className="sv-muted"> · {r.item}</span> : null}
        </span>
      ),
    },
    { key: 'quantity', header: 'Qty', numeric: true, render: (r) => String(r.quantity || 1) },
    { key: 'unitCost', header: 'Unit cost', numeric: true, render: (r) => formatCurrency(r.unitCost) },
    {
      key: 'lineTotal', header: 'Line total', numeric: true,
      render: (r) => formatCurrency(r.lineTotal), footer: formatCurrency(total),
    },
    {
      key: 'status', header: 'Status',
      render: (r) => (r.status
        ? <StatusPill tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>
        : <span className="sv-muted">—</span>),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="CAPEX register"
        subtitle="One row per capital item. The line total follows the workbook's rule (quantity 0 still costs one unit)."
        action={<span className="sv-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns}
          rows={rows}
          caption="CAPEX register"
          getRowKey={(r) => r.id}
          footer
          emptyTitle="No CAPEX for this period"
          emptyMessage="Try a different month, or clear the property filter."
        />
      </CardBody>
    </Card>
  );
}
