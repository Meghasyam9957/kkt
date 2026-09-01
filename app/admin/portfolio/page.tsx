/**
 * INVESTOR PORTFOLIO — the only screen the investor role has, and all it needs.
 *
 * Three rules shape it:
 *
 *   1. **The investor id comes from the session and nowhere else.** There is no parameter,
 *      no query string and no header through which another investor's id could be
 *      supplied, because the page never accepts one. `InvestorService` then filters again
 *      on the server-resolved id — two independent stops, not one.
 *
 *   2. **Portfolio level only.** Net revenue, operating profit and occupancy for the
 *      portfolio; the investor's own capital, participation and distribution. No guest, no
 *      property breakdown, no cost detail, no vendor, no other investor, no operational
 *      note.
 *
 *   3. **Unset rules are stated, not filled in.** When management has not approved the
 *      commercial terms, the distribution section says CONFIGURATION REQUIRED rather than
 *      showing ₹0, which would read as "you are owed nothing".
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { getDataProvider } from '@/lib/data/providers';
import { DemoAssumptionsNotice } from '@/components/demo/DemoAssumptionsNotice';
import { InvestorService } from '@/lib/server/api/investor-service';
import { loadWorkbookForInvestor } from '@/lib/server/api/investor-data';
import { PageHeader, Section, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatMonthLong } from '@/lib/shared/format';

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Portfolio — MAKAM Home Stays' };

export default async function PortfolioPage() {
  const access = await checkPageAccess('investor.self.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  const investorId = access.session.investorId;
  if (!investorId) {
    // A caller holding the capability but carrying no scope must see nothing at all,
    // rather than an unfiltered view. This should be unreachable — the session resolver
    // already refuses an investor without a mapping — so it is a last line, not a path.
    return (
      <>
        <PageHeader title="Portfolio" description="Your investment in MAKAM Home Stays." />
        <Section>
          <EmptyState
            title="No investor record is linked to this account"
            message="Ask an administrator to link your login to an investor record."
          />
        </Section>
      </>
    );
  }

  const provider = getDataProvider();
  const { workbook, monthKey } = await loadWorkbookForInvestor(provider);
  const service = new InvestorService(workbook);

  const overview = service.overview(investorId, monthKey);
  const distributions = service.distributions(investorId, [monthKey]);
  const history = service.performance(investorId).filter((m) => m.netRevenue > 0);
  const configured = overview.portfolio.configured;

  return (
    <>
      <PageHeader
        title={`Portfolio — ${overview.investorName}`}
        description={`Your position as at ${formatMonthLong(monthKey)}. Portfolio-level figures; nothing below is specific to a guest or a unit.`}
      />

      <Section>
        <DemoAssumptionsNotice scope="investor" />
      </Section>

      <Section>
        <div className="sv-kpi-grid">
          <Fact label="Your capital" value={formatCurrency(overview.capitalContributed)} />
          <Fact label="Your participation" value={formatPercent(overview.participationPct)} />
          <Fact label="Status" value={overview.status} />
          <Fact label="Portfolio net revenue" value={formatCurrency(overview.portfolio.netRevenue)} />
          <Fact label="Portfolio operating profit" value={formatCurrency(overview.portfolio.operatingProfit)} />
          <Fact label="Portfolio occupancy" value={formatPercent(overview.portfolio.occupancyPct)} />
        </div>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Your distribution"
            subtitle={configured
              ? `Calculated from your ${formatPercent(overview.participationPct)} participation in the investor pool.`
              : 'Not yet calculable.'}
          />
          <CardBody>
            {configured ? (
              <DataTable
                caption="Your distribution for the period"
                columns={[
                  { key: 'monthKey', header: 'Period', render: (row) => formatMonthLong(row.monthKey) },
                  { key: 'calculatedDistribution', header: 'Calculated', numeric: true, render: (row) => formatCurrency(row.calculatedDistribution) },
                  { key: 'paidAmount', header: 'Paid', numeric: true, render: (row) => formatCurrency(row.paidAmount) },
                  { key: 'pendingAmount', header: 'Pending', numeric: true, render: (row) => formatCurrency(row.pendingAmount) },
                  { key: 'status', header: 'Status', render: (row) => row.status },
                ]}
                rows={distributions}
                getRowKey={(row) => row.monthKey}
                emptyTitle="No distribution for this period"
                emptyMessage="Nothing has been calculated against your participation for this month."
              />
            ) : (
              <EmptyState
                title="Configuration required"
                message={overview.configurationMessage
                  || 'Management has not yet approved the distribution terms, so no figure can be calculated. This is not a zero — it is a decision that has not been made.'}
              />
            )}
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Portfolio performance"
            subtitle="Months the portfolio has traded. Portfolio totals only."
          />
          <CardBody>
            <DataTable
              caption="Portfolio performance by month"
              columns={[
                { key: 'monthKey', header: 'Month', render: (row) => formatMonthLong(row.monthKey) },
                { key: 'netRevenue', header: 'Net revenue', numeric: true, render: (row) => formatCurrency(row.netRevenue) },
                { key: 'operatingProfit', header: 'Operating profit', numeric: true, render: (row) => formatCurrency(row.operatingProfit) },
                { key: 'occupancyPct', header: 'Occupancy', numeric: true, render: (row) => formatPercent(row.occupancyPct) },
              ]}
              rows={history}
              getRowKey={(row) => row.monthKey}
              emptyTitle="The portfolio has not traded yet"
              emptyMessage="There are no months with revenue to report."
            />
          </CardBody>
        </Card>
      </Section>

    </>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="sv-kpi">
      <p className="sv-kpi__label">{label}</p>
      <p className="sv-kpi__value numeric">{value}</p>
    </div>
  );
}
