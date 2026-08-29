import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { FinancialPropertyTable, OperationalPropertyTable } from '@/components/pages/RegisterTables';
import { operationalPropertyRows } from '@/lib/data/views/role-projections';
import { roleSeesFinancialFigures } from '@/lib/shared/roles';

export const metadata = { title: 'Properties — Srivillu Home Stays' };

/**
 * The register is shared, its columns are not. A role with no financial capability gets
 * the OPERATIONAL projection: the financial fields are stripped on the server, before
 * anything renders, so they cannot appear in this response by any later mistake. This is
 * the role contract's "OPERATIONS holds no financial capability" applied to columns, not
 * just to routes.
 */
export default async function PropertiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="properties.read"
      title="Properties"
      description={(viewer) => roleSeesFinancialFigures(viewer.role)
        ? 'The permanent unit register. Performance figures follow the reporting month; direct costs only, since shared costs are not allocated per unit.'
        : 'The permanent unit register, with each unit’s current status. Revenue and profit live on the finance screens.'}
      searchParams={params}
      filters={['month', 'property']}
      fetcher={(provider, filters) => provider.getProperties(filters)}
    >
      {(rows, envelope, viewer) => (roleSeesFinancialFigures(viewer.role)
        ? <FinancialPropertyTable rows={rows} period={envelope.meta.period} />
        : <OperationalPropertyTable rows={operationalPropertyRows(rows)} period={envelope.meta.period} />)}
    </ReadOnlyPage>
  );
}
