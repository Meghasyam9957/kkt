import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort, formatMonthLong } from '@/lib/shared/format';
import type { CashFlowRow } from '@/lib/data/providers/types';
import { NewRecordButton } from '@/components/mutations/actions';
import { cashflowFields } from '@/lib/server/api/form-fields';

function NewCashAction() {
  return (
    <NewRecordButton
      label="+ New Cash Entry"
      title="Record a cash movement"
      endpoint="/api/cashflow"
      fields={cashflowFields()}
      submitLabel="Record movement"
      successTemplate="{id} recorded — the running balance is calculated by the workbook."
      idField="TxnID"
    />
  );
}

export const metadata = { title: 'Cash Flow — MAKAM Home Stays' };

export default async function CashFlowPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="cashflow.read"
      title="Cash Flow"
      description="Actual money movements. This is not the P&L — cash timing and accrual accounting answer different questions, and the system keeps them apart."
      searchParams={params}
      filters={['month', 'property']}
      fetcher={(provider, f) => provider.getCashFlow(f)}
      actions={<NewCashAction />}
    >
      {(rows, envelope) => <CashTable rows={rows} period={envelope.meta.period} />}
    </ReadOnlyPage>
  );
}

function CashTable({ rows, period }: { rows: CashFlowRow[]; period: string }) {
  const totalIn = rows.reduce((t, r) => t + r.moneyIn, 0);
  const totalOut = rows.reduce((t, r) => t + r.moneyOut, 0);
  const closing = rows[0]?.runningBalance ?? 0;

  const columns: Column<CashFlowRow>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDateShort(r.date), footer: 'Period total' },
    { key: 'id', header: 'Txn ID', render: (r) => <code className="numeric">{r.txnId}</code> },
    { key: 'type', header: 'Type', render: (r) => r.type },
    { key: 'property', header: 'Property', render: (r) => r.propertyId || '—' },
    {
      key: 'in', header: 'Money in', numeric: true,
      render: (r) => (r.moneyIn > 0 ? formatCurrency(r.moneyIn) : '—'),
      footer: formatCurrency(totalIn),
    },
    {
      key: 'out', header: 'Money out', numeric: true,
      render: (r) => (r.moneyOut > 0 ? formatCurrency(r.moneyOut) : '—'),
      footer: formatCurrency(totalOut),
    },
    {
      key: 'balance', header: 'Running balance', numeric: true,
      render: (r) => <span className={r.runningBalance < 0 ? 'sv-negative' : ''}>{formatCurrency(r.runningBalance)}</span>,
      footer: formatCurrency(closing),
    },
    {
      key: 'recon', header: 'Reconciliation',
      render: (r) => (
        <StatusPill tone={r.reconStatus === 'Reconciled' ? 'good' : r.reconStatus === 'Disputed' ? 'bad' : 'warn'}>
          {r.reconStatus}
        </StatusPill>
      ),
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Cash ledger"
        subtitle={`Movements during ${formatMonthLong(period)}. The running balance is cumulative from the start of the ledger, not reset each month.`}
        action={<span className="sv-muted">{rows.length} transaction{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Cash flow ledger"
          getRowKey={(r) => r.txnId} footer
          emptyTitle="No cash movements this period"
          emptyMessage="Nothing moved in or out during the selected month."
        />
      </CardBody>
    </Card>
  );
}
