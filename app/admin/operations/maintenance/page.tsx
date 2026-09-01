import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { MaintenanceTable } from '@/components/pages/OpsTables';
import { NewRecordButton } from '@/components/mutations/actions';
import { maintenanceFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';

export const metadata = { title: 'Maintenance — MAKAM Home Stays' };

async function NewIssueAction() {
  const propertyIds = await getDataProvider().getPropertyIds();
  return (
    <NewRecordButton
      label="+ New Maintenance Issue"
      title="Report a maintenance issue"
      endpoint="/api/maintenance"
      fields={maintenanceFields(propertyIds)}
      submitLabel="Create ticket"
      successTemplate="{id} created — it appears on the board immediately."
      idField="TicketID"
    />
  );
}

export default async function MaintenancePage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="maintenance.read"
      title="Maintenance"
      description="Open tickets, most pressing first. No financial figures appear on this screen."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
      actions={<NewIssueAction />}
    >
      {(board) => <MaintenanceTable rows={board.maintenance} />}
    </ReadOnlyPage>
  );
}
