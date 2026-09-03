import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { InventoryTable } from '@/components/pages/OpsTables';
import { inventoryItemDetailFields } from '@/lib/server/api/form-fields';

export const metadata = { title: 'Inventory — MAKAM Home Stays' };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="inventory.read"
      title="Inventory"
      description="Stock on hand, as the workbook calculates it. Recording what moved — and why — is under Stock."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => <InventoryTable rows={board.stock} itemDetailFields={inventoryItemDetailFields()} />}
    </ReadOnlyPage>
  );
}
