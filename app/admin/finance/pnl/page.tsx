import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, TableScroller } from '@/components/ui/primitives';
import { formatCurrency, formatPercent } from '@/lib/shared/format';
import type { PnlView } from '@/lib/data/providers/types';

export const metadata = { title: 'P&L — MAKAM Home Stays' };

export default async function PnlPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="pnl.read"
      title="Monthly P&L"
      description="Management accrual view across the financial year. Expense lines use the workbook's own subcategory mapping, so this reconciles to the sheet rather than re-categorising it."
      searchParams={params}
      showFilters={false}
      fetcher={(provider, f) => provider.getPnl(f)}
    >
      {(pnl) => <PnlTable pnl={pnl} />}
    </ReadOnlyPage>
  );
}

function PnlTable({ pnl }: { pnl: PnlView }) {
  return (
    <Card>
      <CardHeader
        title="Profit & loss"
        subtitle="CAPEX and investor distributions sit below the line as memo items — they never affect operating profit."
      />
      <CardBody className="sv-card__body--flush">
        <TableScroller label="Monthly profit and loss">
          <table className="sv-table">
            <caption className="sv-visually-hidden">Monthly profit and loss</caption>
            <thead>
              <tr>
                <th scope="col">Line</th>
                {pnl.monthLabels.map((label) => <th key={label} scope="col" className="sv-num">{label}</th>)}
                <th scope="col" className="sv-num">FY total</th>
              </tr>
            </thead>
            <tbody>
              {pnl.lines.map((line) => {
                if (line.emphasis === 'section') {
                  return (
                    <tr key={line.key} className="sv-table__row--section">
                      <th scope="colgroup" colSpan={pnl.monthLabels.length + 2}
                        style={{ textTransform: 'uppercase', fontSize: '0.6875rem', letterSpacing: '0.08em' }}>
                        {line.label}
                      </th>
                    </tr>
                  );
                }
                const fmt = (v: number) => (line.isPercent ? formatPercent(v) : formatCurrency(v));
                /*
                 * The stylesheet's own emphasis classes, not an inline tint. The tint was
                 * `rgba(79,95,44,0.07)` — the brand olive at 7%, which over a white card
                 * resolves to roughly #F5F6F1 and marks the single most important row of a
                 * financial statement with a 2% difference nobody can see. The shared rules
                 * carry a rule ABOVE the row instead, which is how a statement has always
                 * shown a total.
                 */
                return (
                  <tr key={line.key}
                    className={line.emphasis ? `sv-table__row--${line.emphasis}` : undefined}
                    style={line.memo ? { color: 'var(--text-muted)' } : undefined}>
                    <th scope="row" style={{ textAlign: 'left' }}>{line.label}</th>
                    {line.values.map((value, i) => (
                      <td key={i} className="sv-num">
                        <span className={value < 0 && !line.isPercent && line.emphasis === 'total' ? 'sv-negative' : ''}>
                          {fmt(value)}
                        </span>
                      </td>
                    ))}
                    <td className="sv-num">{line.isPercent ? '—' : formatCurrency(line.total)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroller>
      </CardBody>
    </Card>
  );
}
