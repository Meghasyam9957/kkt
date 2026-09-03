import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, ConfigurationRequired, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatMonthLong } from '@/lib/shared/format';
import type { InvestorPreviewView } from '@/lib/data/providers/types';
import type { InvestorAllocation } from '@/lib/shared/domain';

export const metadata = { title: 'Distributions — MAKAM Home Stays' };

export default async function DistributionsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="investor"
      capability="investors.read.all"
      title="Investor distributions"
      description="The profit waterfall for the selected period, and what each investor would receive under it."
      searchParams={params}
      filters={['month']}
      fetcher={(provider, f) => provider.getInvestorPreview(f)}
    >
      {(preview, envelope) => <Distributions preview={preview} period={envelope.meta.period} />}
    </ReadOnlyPage>
  );
}

function Distributions({ preview, period }: { preview: InvestorPreviewView; period: string }) {
  const w = preview.waterfall;

  const steps: Array<{ label: string; value: number; note?: string; emphasis?: boolean }> = [
    { label: 'Gross revenue', value: w.grossRevenue },
    { label: 'Less: discounts', value: -w.discounts },
    { label: 'Less: platform fees', value: -w.platformFees },
    { label: 'Less: taxes', value: -w.taxes },
    { label: 'Net revenue', value: w.netRevenue, emphasis: true },
    { label: 'Less: operating expenses', value: -w.operatingExpenses, note: 'CAPEX excluded' },
    { label: 'Operating profit', value: w.operatingProfit, emphasis: true },
  ];

  const columns: Column<InvestorAllocation>[] = [
    { key: 'id', header: 'Investor', render: (a) => <code className="numeric">{a.investorId}</code> },
    { key: 'name', header: 'Name', render: (a) => a.investorName },
    { key: 'share', header: 'Allocation', numeric: true, render: (a) => formatPercent(a.participationPct, 0) },
    {
      key: 'calculated', header: 'Calculated', numeric: true,
      render: (a) => (preview.configured ? formatCurrency(a.calculatedDistribution) : <span className="sv-muted">Not configured</span>),
    },
    { key: 'paid', header: 'Paid', numeric: true, render: (a) => formatCurrency(a.paidAmount) },
    {
      key: 'pending', header: 'Pending', numeric: true,
      render: (a) => (preview.configured ? formatCurrency(a.pendingAmount) : <span className="sv-muted">—</span>),
    },
    {
      key: 'status', header: 'Status',
      render: (a) => (
        <StatusPill tone={a.status === 'Paid' ? 'good' : a.status === 'Partial' ? 'info'
          : a.status === 'Pending' ? 'warn' : 'neutral'}>
          {a.status}
        </StatusPill>
      ),
    },
  ];

  return (
    <>
      {!preview.configured ? (
        <>
          <ConfigurationRequired message={
            `${preview.configurationMessage} Operating profit is reported accurately; only the split between investor and operator is withheld.`
          } />
          <div style={{ height: 'var(--space-4)' }} />
        </>
      ) : null}

      <Card>
        <CardHeader title={`Waterfall — ${formatMonthLong(period)}`}
          subtitle="Every percentage comes from the workbook's business rules. Nothing is assumed here." />
        <CardBody className="sv-card__body--flush">
          <table className="sv-table">
            <caption className="sv-visually-hidden">Distribution waterfall</caption>
            <tbody>
              {steps.map((step) => (
                <tr key={step.label} style={{ fontWeight: step.emphasis ? 600 : 400 }}>
                  <th scope="row" style={{ textAlign: 'left', fontWeight: 'inherit' }}>
                    {step.label}
                    {step.note ? <span className="sv-muted"> · {step.note}</span> : null}
                  </th>
                  <td className="sv-num">{formatCurrency(step.value)}</td>
                </tr>
              ))}
              <tr className="sv-table__row--subtotal">
                <th scope="row" style={{ textAlign: 'left' }}>Reserve · management fee · carry-forward</th>
                <td className="sv-num">
                  {preview.configured
                    ? formatCurrency(-(w.reserve + w.mgmtFee + w.carryForwardApplied))
                    : <span className="sv-muted">Not configured</span>}
                </td>
              </tr>
              {/* The shared total treatment: a double rule above, as a statement draws it. */}
              <tr className="sv-table__row--total">
                <th scope="row" style={{ textAlign: 'left' }}>Distributable profit</th>
                <td className="sv-num">
                  {preview.configured
                    ? formatCurrency(w.distributableProfit)
                    : <span className="sv-muted">Not configured</span>}
                </td>
              </tr>
              <tr>
                <th scope="row" style={{ textAlign: 'left' }}>Investor pool</th>
                <td className="sv-num">
                  {preview.configured
                    ? `${formatPercent(w.investorPoolPct ?? 0, 0)} · ${formatCurrency(w.investorPoolAmt)}`
                    : <span className="sv-muted">Not configured</span>}
                </td>
              </tr>
            </tbody>
          </table>
        </CardBody>
      </Card>

      <div style={{ height: 'var(--space-4)' }} />

      <Card>
        <CardHeader title="Allocation by investor" subtitle="Each investor's share of the pool for this period." />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={columns} rows={preview.allocations} caption="Investor allocations"
            getRowKey={(a) => a.investorId}
            emptyTitle="No investors" emptyMessage="Add investors to the register to see allocations."
          />
        </CardBody>
      </Card>
    </>
  );
}
