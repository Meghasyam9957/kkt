import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill, Badge, ConfigurationRequired } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatPercent, formatDate } from '@/lib/shared/format';
import type { SettingsView } from '@/lib/data/providers/types';

export const metadata = { title: 'Settings — Srivillu Home Stays' };

export default async function SettingsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="settings.read"
      title="Settings"
      description="Configuration as it stands in the workbook. This screen is read-only by design — business rules stay editable in one audited place."
      searchParams={params}
      showFilters={false}
      fetcher={(provider) => provider.getSettings()}
    >
      {(settings) => <SettingsPanels settings={settings} />}
    </ReadOnlyPage>
  );
}

type Rule = SettingsView['businessRules'][number];
type Platform = SettingsView['platforms'][number];

function SettingsPanels({ settings }: { settings: SettingsView }) {
  const unconfigured = settings.businessRules.filter((r) => !r.configured).length;

  const ruleColumns: Column<Rule>[] = [
    { key: 'label', header: 'Rule', render: (r) => r.label },
    {
      key: 'value', header: 'Value',
      render: (r) => (r.configured
        ? <strong className="numeric">{r.value}</strong>
        : <StatusPill tone="warn">TBD</StatusPill>),
    },
    {
      key: 'applied', header: 'Applied in calculations',
      render: (r) => (r.recordedOnly
        ? <StatusPill tone="neutral">Recorded only</StatusPill>
        : <StatusPill tone={r.configured ? 'good' : 'warn'}>{r.configured ? 'Live' : 'Idle until set'}</StatusPill>),
    },
  ];

  const platformColumns: Column<Platform>[] = [
    { key: 'name', header: 'Platform', render: (p) => p.name },
    {
      key: 'commission', header: 'Commission', numeric: true,
      render: (p) => (p.commissionPct === null
        ? <StatusPill tone="warn">TBD</StatusPill>
        : formatPercent(p.commissionPct, 0)),
    },
    { key: 'lag', header: 'Payout lag', numeric: true, render: (p) => `${p.payoutLagDays} day${p.payoutLagDays === 1 ? '' : 's'}` },
  ];

  return (
    <>
      <Card>
        <CardHeader title="Business" />
        <CardBody>
          <dl className="sv-board__metrics" style={{ borderTop: 'none', marginTop: 0, paddingTop: 0 }}>
            <Field label="Business name" value={settings.businessName} />
            <Field label="City" value={`${settings.city}, ${settings.country}`} />
            <Field label="Currency" value={settings.currency} />
            <Field label="Financial year starts" value={formatDate(settings.fyStart)} />
          </dl>
        </CardBody>
      </Card>

      <div style={{ height: 'var(--space-4)' }} />

      {unconfigured > 0 ? (
        <>
          <ConfigurationRequired message={
            `${unconfigured} business rule${unconfigured === 1 ? ' is' : 's are'} still TBD. Until management approves them, the distribution engine calculates nothing and investor figures are withheld rather than shown as zero.`
          } />
          <div style={{ height: 'var(--space-4)' }} />
        </>
      ) : null}

      <Card>
        <CardHeader
          title="Business rules"
          subtitle="Commercial terms. Rules marked 'recorded only' are captured for reference but are not yet wired into the calculations."
          action={<Badge tone="warn">Edited in the workbook</Badge>}
        />
        <CardBody className="sv-card__body--flush">
          <DataTable columns={ruleColumns} rows={settings.businessRules} caption="Business rules"
            getRowKey={(r) => r.name} />
        </CardBody>
      </Card>

      <div style={{ height: 'var(--space-4)' }} />

      <Card>
        <CardHeader title="Channels" subtitle="Commission is used to estimate a payout when a booking has no fee recorded." />
        <CardBody className="sv-card__body--flush">
          <DataTable columns={platformColumns} rows={settings.platforms} caption="Platforms"
            getRowKey={(p) => p.name} />
        </CardBody>
      </Card>
    </>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="sv-board__metric">
      <dt className="sv-board__metric-label">{label}</dt>
      <dd className="sv-board__metric-value" style={{ margin: 0 }}>{value}</dd>
    </div>
  );
}
