import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { HousekeepingTable } from '@/components/pages/OpsTables';
import { NewRecordButton } from '@/components/mutations/actions';
import { housekeepingFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';
import { requireTenantContext } from '@/lib/server/auth/page-guard';
import { assignmentContextForPage } from '@/lib/server/operations/page-assignment';

export const metadata = { title: 'Housekeeping — MAKAM Home Stays' };

async function NewTurnoverAction() {
  const propertyIds = await (await getDataProvider(await requireTenantContext())).getPropertyIds();
  return (
    <NewRecordButton
      label="+ New Turnover"
      title="Create a housekeeping task"
      endpoint="/api/housekeeping"
      fields={housekeepingFields(propertyIds)}
      submitLabel="Create task"
      successTemplate="{id} created."
      idField="TaskID"
    />
  );
}

export default async function HousekeepingPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  // Resolved once for the whole board rather than once per row, and undefined for a
  // viewer without operations.staff.read — see page-assignment.ts.
  const assignment = await assignmentContextForPage('HOUSEKEEPING', params.property);
  return (
    <ReadOnlyPage
      capability="housekeeping.read"
      title="Housekeeping"
      description="Turnovers between stays. No financial figures appear on this screen."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
      actions={<NewTurnoverAction />}
    >
      {(board) => <HousekeepingTable rows={board.cleaning} assignment={assignment} />}
    </ReadOnlyPage>
  );
}
