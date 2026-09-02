/**
 * ASSETS — the register the workbook has always had and nothing has ever read.
 *
 * `16_ASSETS` existed in the contract and in the domain types with no grid behind it and no
 * screen in front of it, so every air conditioner, television and smart lock the business
 * owns was invisible to the product. This is where that stops.
 *
 * WHAT IS NOT MODELLED HERE, deliberately: depreciation, net book value, useful-life
 * amortisation, or any other accounting treatment. `purchaseCostMinor` is what was PAID.
 * Rendering a purchase price as a book value would be an accounting claim nobody has made,
 * and the difference between the two is somebody's tax position.
 *
 * WARRANTY IS ANSWERED TWICE, on purpose. The workbook's own `Warranty` cell is a formula and
 * is shown verbatim; beside it is the forward-looking signal derived from the expiry DATE —
 * because a warranty noticed the day after it lapsed is a repair the business now pays for,
 * and the sheet's answer, being about today, cannot say that.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { inventoryServiceFor } from '@/lib/server/api/service';
import { assetItemView, type AssetItemView } from '@/lib/server/inventory/projections';
import {
  inventoryPageContext, type InventoryPageContext,
} from '@/lib/server/inventory/page-context';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import { LinkTicketButton } from '@/components/inventory/LinkTicketButton';

export const metadata = { title: 'Assets — MAKAM Home Stays' };

const WARRANTY: Record<string, { label: string; tone: Tone }> = {
  ACTIVE: { label: 'in warranty', tone: 'good' },
  EXPIRING: { label: 'expires within 60 days', tone: 'warn' },
  EXPIRED: { label: 'out of warranty', tone: 'neutral' },
  UNKNOWN: { label: 'no expiry recorded', tone: 'neutral' },
};

const CONDITION_TONE: Record<string, Tone> = {
  New: 'good', Good: 'good', Fair: 'warn', Poor: 'warn', Broken: 'bad',
};

export default async function AssetsPage() {
  const access = await checkPageAccess('inventory.assets');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  let rows: AssetItemView[];
  let context: InventoryPageContext;
  try {
    context = await inventoryPageContext(access.tenant, access.session.role);
    rows = (await inventoryServiceFor().assets(access.tenant))
      .map((a) => assetItemView(a, context.maySeeMoney));
  } catch (error) {
    console.error('[inventory] assets failed:', error);
    return (
      <>
        <PageHeader title="Assets" description="What the business owns." />
        <Section>
          <ErrorState message="We couldn't read the asset register just now. Try again in a moment." />
        </Section>
      </>
    );
  }

  const expiring = rows.filter((a) => a.warrantyState === 'EXPIRING');
  const underRepair = rows.filter((a) => a.status === 'Under Repair');
  const broken = rows.filter((a) => a.condition === 'Broken');

  const columns: Column<AssetItemView>[] = [
    {
      key: 'asset', header: 'Asset',
      render: (a) => (
        <span>
          <strong>{a.name}</strong>
          <span className="sv-muted"> · <code className="numeric">{a.assetRef}</code></span>
        </span>
      ),
    },
    { key: 'category', header: 'Category', render: (a) => a.category || '—' },
    {
      key: 'where', header: 'Where',
      render: (a) => (a.propertyId === 'COMMON' ? 'Shared' : a.propertyId ?? '—'),
    },
    {
      key: 'condition', header: 'Condition',
      render: (a) => (
        <StatusPill tone={CONDITION_TONE[a.condition] ?? 'neutral'}>
          {a.condition.toLowerCase()}
        </StatusPill>
      ),
    },
    { key: 'status', header: 'Status', render: (a) => a.status },
    {
      key: 'warranty', header: 'Warranty',
      render: (a) => {
        const meta = WARRANTY[a.warrantyState] ?? { label: a.warrantyState, tone: 'neutral' as Tone };
        return (
          <span className="sv-assigned">
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
            <span className="sv-muted">
              {a.warrantyExpiry ? `until ${formatDateShort(a.warrantyExpiry)}` : ''}
              {/* The sheet's own word for it, kept beside the derived one. */}
              {a.warrantyLabel ? ` · sheet says “${a.warrantyLabel}”` : ''}
            </span>
          </span>
        );
      },
    },
    {
      key: 'cost', header: 'Paid', numeric: true,
      render: (a) => {
        if (a.costWithheld) return <span className="sv-muted">not shown to you</span>;
        if (a.purchaseCostMinor === null) return <span className="sv-muted">—</span>;
        // What was PAID, on the date shown. Never a book value: nothing here depreciates.
        return <span className="numeric">{formatCurrency(a.purchaseCostMinor / 100, true)}</span>;
      },
    },
    {
      key: 'tickets', header: 'Maintenance',
      render: (a) => (a.linkedTickets.length === 0
        ? <span className="sv-muted">nothing linked</span>
        : (
          <span>
            {a.linkedTickets.map((t) => <code className="numeric" key={t}>{t}</code>)}
          </span>
        )),
    },
    {
      key: 'action', header: '',
      render: (a) => (
        <LinkTicketButton assetRef={a.assetRef} assetName={a.name} context={context} />
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="Assets"
        description="The workbook’s own register, read for the first time — with the tickets it could only mention in prose."
      />

      <Section>
        <Card>
          <CardHeader title="What the business owns" />
          <CardBody>
            <div className="sv-kpi-grid">
              <Count label="Assets" value={rows.length} />
              <Count label="Warranty expiring" value={expiring.length} tone="warn" />
              <Count label="Under repair" value={underRepair.length} />
              <Count label="Broken" value={broken.length} tone="bad" />
            </div>
            <p className="sv-kpi__note">
              Purchase cost is what was paid. Nothing here is depreciated, revalued or written
              down — that is an accounting treatment, and this product does not make one.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Every asset"
            subtitle="Linking a ticket says which repair was about which thing — a question the sheet’s free-text history cannot answer."
          />
          <CardBody>
            <DataTable
              columns={columns}
              rows={rows}
              caption="The asset register"
              getRowKey={(a) => a.assetRef}
              emptyTitle="No assets"
              emptyMessage="16_ASSETS has no rows in this workbook yet."
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
