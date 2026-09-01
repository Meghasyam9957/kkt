/**
 * THE INVESTOR'S OWN SCREEN — their position, and how the business they funded is trading.
 *
 * Four rules shape it:
 *
 *   1. **The investor id comes from the session and nowhere else.** There is no parameter,
 *      no query string and no header through which another investor's id could be
 *      supplied, because the page never accepts one. `InvestorService` then filters again
 *      on the server-resolved id — two independent stops, not one.
 *
 *   2. **Portfolio level only.** Net revenue, operating profit, occupancy and
 *      distributable profit for the portfolio; the investor's own capital, participation
 *      and distribution. No guest, no property breakdown, no cost detail, no vendor, no
 *      other investor, no operational note.
 *
 *      That is not a limitation of this screen — it is what the data models. An investor
 *      holds `ParticipationPct`, a share WITHIN the investor pool, and no ownership
 *      relation to any unit exists in either direction. UI-9 asked for a per-property
 *      owner experience and could not build one for that reason; the evidence and the
 *      business decision it needs are in docs/UI9_OWNER_DECISIONS.md. The scope line under
 *      the portfolio figures says so on the screen, so nobody has to guess whether a
 *      number is theirs alone or the whole business's.
 *
 *   3. **Unset rules are stated, not filled in.** Where management has not approved the
 *      commercial terms, the distribution says CONFIGURATION REQUIRED rather than showing
 *      ₹0, which would read as "you are owed nothing".
 *
 *   4. **Shape first, then figures.** The trend is a chart — an investor's first question
 *      is whether the line is going up, not what March was to the rupee. Both charts carry
 *      their own tabular equivalent for a screen reader, and the exact months are in a
 *      table beneath that becomes a stack of records on a phone rather than a four-column
 *      squeeze.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { getDataProvider } from '@/lib/data/providers';
import { DemoAssumptionsNotice } from '@/components/demo/DemoAssumptionsNotice';
import { InvestorService } from '@/lib/server/api/investor-service';
import { loadWorkbookForInvestor } from '@/lib/server/api/investor-data';
import {
  PageHeader, Section, Card, CardHeader, CardBody, EmptyState, StatusPill,
} from '@/components/ui/primitives';
import { DataTable } from '@/components/ui/DataTable';
import { RevenueTrendChart, OccupancyTrendChart } from '@/components/charts/Charts';
import {
  formatCurrency, formatPercent, formatMonthLong, formatMonthShort,
} from '@/lib/shared/format';

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
  const traded = service.performance(investorId).filter((m) => m.netRevenue > 0);
  const configured = overview.portfolio.configured;

  return (
    <>
      <PageHeader
        title={`Portfolio — ${overview.investorName}`}
        description={`Your position as at ${formatMonthLong(monthKey)}.`}
      />

      <Section>
        <DemoAssumptionsNotice scope="investor" />
      </Section>

      {/* ---------- 1 · what is mine ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Your position"
            subtitle="Your own investment in the business, and where it stands."
            action={<StatusPill tone={overview.status === 'Active' ? 'good' : 'neutral'}>{overview.status}</StatusPill>}
          />
          <CardBody>
            <div className="sv-kpi-grid m-stagger">
              <Fact label="Your capital" value={formatCurrency(overview.capitalContributed)} />
              <Fact
                label="Your participation"
                value={formatPercent(overview.participationPct)}
                note="Your share within the investor pool."
              />
            </div>
          </CardBody>
        </Card>
      </Section>

      {/* ---------- 2 · how the business is trading ---------- */}
      <Section>
        <Card>
          <CardHeader
            title={`The portfolio in ${formatMonthLong(monthKey)}`}
            /*
             * Said out loud, because it is the question an investor would otherwise have
             * to guess at: these are the whole business's figures, not a unit's and not a
             * share of one. No ownership of any individual property exists to report.
             */
            subtitle="The whole business, not a single property — your participation is a share of the pool, not of a unit."
          />
          <CardBody>
            <div className="sv-kpi-grid m-stagger">
              <Fact label="Net revenue" value={formatCurrency(overview.portfolio.netRevenue)} />
              <Fact label="Operating profit" value={formatCurrency(overview.portfolio.operatingProfit)} />
              <Fact label="Occupancy" value={formatPercent(overview.portfolio.occupancyPct)} />
              <Fact
                label="Distributable profit"
                value={configured ? formatCurrency(overview.portfolio.distributableProfit) : 'Not yet calculable'}
                note={configured ? undefined : 'The distribution rules are not approved.'}
              />
            </div>
          </CardBody>
        </Card>
      </Section>

      {/* ---------- 3 · the shape of it ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="How the portfolio has traded"
            subtitle="Every month the business has earned revenue. Portfolio totals only."
          />
          <CardBody>
            {traded.length === 0 ? (
              <EmptyState
                title="The portfolio has not traded yet"
                message="There are no months with revenue to report."
              />
            ) : (
              <>
                {/* Both charts render an equivalent table for a screen reader and hide the
                    drawing from it — the figures are never carried by the picture alone. */}
                <RevenueTrendChart
                  title="Net revenue by month"
                  points={traded.map((m) => ({ label: formatMonthShort(m.monthKey), value: m.netRevenue }))}
                />
                <OccupancyTrendChart
                  title="Occupancy by month"
                  points={traded.map((m) => ({ label: formatMonthShort(m.monthKey), value: m.occupancyPct }))}
                />
              </>
            )}
          </CardBody>

          {traded.length > 0 ? (
            <CardBody className="sv-card__body--flush">
              <DataTable
                caption="Portfolio performance by month"
                columns={[
                  { key: 'monthKey', header: 'Month', render: (row) => formatMonthLong(row.monthKey) },
                  { key: 'netRevenue', header: 'Net revenue', numeric: true, render: (row) => formatCurrency(row.netRevenue) },
                  { key: 'operatingProfit', header: 'Operating profit', numeric: true, render: (row) => formatCurrency(row.operatingProfit) },
                  { key: 'occupancyPct', header: 'Occupancy', numeric: true, render: (row) => formatPercent(row.occupancyPct) },
                ]}
                rows={traded}
                /* A phone gets records, not a four-column finance table squeezed to fit. */
                mobile="stack"
                getRowKey={(row) => row.monthKey}
                emptyTitle="The portfolio has not traded yet"
                emptyMessage="There are no months with revenue to report."
              />
            </CardBody>
          ) : null}
        </Card>
      </Section>

      {/* ---------- 4 · what is owed ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Your distribution"
            subtitle={configured
              ? `Calculated from your ${formatPercent(overview.participationPct)} participation in the investor pool.`
              : 'Not yet calculable.'}
          />
          <CardBody className={configured ? 'sv-card__body--flush' : ''}>
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
                mobile="stack"
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

      {/* ---------- 5 · statements ---------- */}
      <Section>
        <Card>
          <CardHeader
            title="Statements"
            subtitle="Released after a period is closed and its distribution is approved."
          />
          <CardBody>
            {/*
              * Nothing is offered, and both reasons are named. A statement needs approved
              * distribution rules AND a closed period; `18_MONTHLY_CLOSE` exists in the
              * workbook but no repository reads it yet, so no period can be shown as
              * released. Naming one condition and not the other would send somebody to
              * chase the wrong thing. See docs/UI9_OWNER_DECISIONS.md.
              */}
            <EmptyState
              title="No statements are available yet"
              message={configured
                ? 'A statement is released once management closes the period. None has been released to you yet.'
                : 'Two things are still outstanding: the distribution terms have not been approved, and no period has been closed for release. A statement cannot be produced from either alone.'}
            />
          </CardBody>
        </Card>
      </Section>
    </>
  );
}

function Fact({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="sv-kpi m-reveal">
      <p className="sv-kpi__label">{label}</p>
      <p className="sv-kpi__value numeric">{value}</p>
      {note ? <p className="sv-kpi__note">{note}</p> : null}
    </div>
  );
}
