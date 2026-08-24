'use client';
/**
 * LEDGER PAGE — shared shape for Revenue and Expenses.
 *
 * Both are the same screen with different columns and labels, so they share one
 * component. Totals are summed here for display only; every underlying figure was
 * computed by the server-side engine.
 */
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import type { LedgerRow } from '@/lib/data/providers/types';

const STATUS_TONE: Record<string, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  Received: 'good', Paid: 'good',
  Pending: 'warn', Partial: 'info', Overdue: 'bad', Failed: 'bad',
  'Written Off': 'neutral',
};

export function LedgerTable({
  rows, kind, caption,
}: { rows: LedgerRow[]; kind: 'revenue' | 'expense'; caption: string }) {
  const totalGross = rows.reduce((t, r) => t + r.gross, 0);
  const totalDeductions = rows.reduce((t, r) => t + r.deductions, 0);
  const totalNet = rows.reduce((t, r) => t + r.net, 0);

  const columns: Column<LedgerRow>[] = [
    { key: 'date', header: 'Date', render: (r) => formatDateShort(r.date), footer: 'Total' },
    { key: 'id', header: kind === 'revenue' ? 'Revenue ID' : 'Expense ID', render: (r) => <code className="numeric">{r.id}</code> },
    { key: 'property', header: 'Property', render: (r) => r.propertyId || '—' },
    {
      key: 'category',
      header: kind === 'revenue' ? 'Type' : 'Category',
      render: (r) => (
        <span>
          {r.category}
          {r.subCategory ? <span className="sv-muted"> · {r.subCategory}</span> : null}
        </span>
      ),
    },
    ...(kind === 'revenue'
      ? [{ key: 'platform', header: 'Platform', render: (r: LedgerRow) => r.platform ?? '—' }]
      : []),
    {
      key: 'gross', header: kind === 'revenue' ? 'Gross' : 'Amount', numeric: true,
      render: (r) => formatCurrency(r.gross), footer: formatCurrency(totalGross),
    },
    {
      key: 'deductions', header: kind === 'revenue' ? 'Deductions' : 'Tax', numeric: true,
      render: (r) => formatCurrency(r.deductions), footer: formatCurrency(totalDeductions),
    },
    {
      key: 'net', header: kind === 'revenue' ? 'Net revenue' : 'Total', numeric: true,
      render: (r) => formatCurrency(r.net), footer: formatCurrency(totalNet),
    },
    {
      key: 'status', header: 'Status',
      render: (r) => <StatusPill tone={STATUS_TONE[r.status] ?? 'neutral'}>{r.status}</StatusPill>,
    },
  ];

  return (
    <Card>
      <CardHeader
        title={kind === 'revenue' ? 'Revenue ledger' : 'Operating expenses'}
        subtitle={kind === 'revenue'
          ? 'One row per revenue transaction. Net is gross less discounts, taxes, platform fees and other deductions.'
          : 'Operating expenses only. CAPEX is tracked separately and never enters operating profit.'}
        action={<span className="sv-muted">{rows.length} row{rows.length === 1 ? '' : 's'}</span>}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns}
          rows={rows}
          caption={caption}
          getRowKey={(r) => r.id}
          footer
          emptyTitle={kind === 'revenue' ? 'No revenue for this period' : 'No expenses for this period'}
          emptyMessage="Try a different month, or clear the property and platform filters."
        />
      </CardBody>
    </Card>
  );
}
