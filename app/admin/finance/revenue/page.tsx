import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { LedgerTable } from '@/components/pages/LedgerPage';
import { NewRecordButton } from '@/components/mutations/actions';
import { revenueFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';
import { requireTenantContext } from '@/lib/server/auth/page-guard';

async function NewRevenueAction() {
  const provider = await getDataProvider(await requireTenantContext());
  const [propertyIds, platforms] = await Promise.all([provider.getPropertyIds(), provider.getPlatforms()]);
  return (
    <NewRecordButton
      label="+ New Revenue"
      title="Record revenue"
      endpoint="/api/revenue"
      fields={revenueFields(propertyIds, platforms)}
      submitLabel="Record revenue"
      successTemplate="{id} recorded — net revenue is calculated by the workbook."
      idField="RevenueID"
      wide
    />
  );
}

export const metadata = { title: 'Revenue — MAKAM Home Stays' };

export default async function RevenuePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="revenue.read"
      title="Revenue"
      description="Every revenue transaction recognised in the selected month, with the deductions that bridge gross to net."
      searchParams={params}
      filters={['month', 'property', 'platform']}
      fetcher={(provider, f) => provider.getRevenue(f)}
      actions={<NewRevenueAction />}
    >
      {(rows) => <LedgerTable rows={rows} kind="revenue" caption="Revenue ledger" />}
    </ReadOnlyPage>
  );
}
