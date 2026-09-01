import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill, ConfigurationRequired } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent } from '@/lib/shared/format';
import type { InvestorPreviewView, InvestorRegisterRow } from '@/lib/data/providers/types';

export const metadata = { title: 'Investors — MAKAM Home Stays' };

export default async function InvestorsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="investor"
      capability="investors.read.all"
      title="Investors"
      description="Capital register and participation. Distribution figures stay unavailable until management approves the commercial terms."
      searchParams={params}
      filters={['month']}
      fetcher={async (provider, f) => {
        // Both come from the provider. The register used to be imported from the demo
        // fixtures, which would have put fictional investors on a production screen.
        const [preview, register] = await Promise.all([
          provider.getInvestorPreview(f),
          provider.getInvestorRegister(),
        ]);
        return { data: { preview: preview.data, register: register.data }, meta: preview.meta };
      }}
    >
      {({ preview, register }) => <InvestorRegister preview={preview} register={register} />}
    </ReadOnlyPage>
  );
}

function InvestorRegister({ preview, register }: {
  preview: InvestorPreviewView;
  register: InvestorRegisterRow[];
}) {
  const totalCapital = register.reduce((t, i) => t + i.investmentAmount, 0);
  const totalShare = register.filter((i) => i.status === 'Active')
    .reduce((t, i) => t + i.participationPct, 0);

  const columns: Column<InvestorRegisterRow>[] = [
    { key: 'id', header: 'Investor ID', render: (i) => <code className="numeric">{i.investorId}</code>, footer: 'Total' },
    { key: 'name', header: 'Investor', render: (i) => i.investorName },
    { key: 'capital', header: 'Capital contributed', numeric: true, render: (i) => formatCurrency(i.investmentAmount), footer: formatCurrency(totalCapital) },
    { key: 'share', header: 'Participation', numeric: true, render: (i) => formatPercent(i.participationPct, 0), footer: formatPercent(totalShare, 0) },
    { key: 'status', header: 'Status', render: (i) => <StatusPill tone={i.status === 'Active' ? 'good' : 'neutral'}>{i.status}</StatusPill> },
  ];

  return (
    <>
      {!preview.configured ? (
        <>
          <ConfigurationRequired message={preview.configurationMessage} />
          <div style={{ height: 'var(--space-4)' }} />
        </>
      ) : null}

      <Card>
        <CardHeader
          title="Capital register"
          subtitle="Participation is a share of the investor pool. Active participations must total 100%."
        />
        <CardBody className="sv-card__body--flush">
          <DataTable
            columns={columns} rows={register} caption="Investor register"
            getRowKey={(i) => i.investorId} footer
          />
        </CardBody>
      </Card>
    </>
  );
}
