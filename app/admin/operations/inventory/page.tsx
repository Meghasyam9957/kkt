import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { InventoryTable } from '@/components/pages/OpsTables';
import { inventoryMovementFields } from '@/lib/server/api/form-fields';

export const metadata = { title: 'Inventory — Srivillu Home Stays' };

export default async function InventoryPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="inventory.read"
      title="Inventory"
      description="Stock on hand. Movements record purchased and used counts; the workbook calculates the current stock."
      searchParams={params}
      filters={['property']}
      fetcher={(provider, f) => provider.getOperations(f)}
    >
      {(board) => <InventoryTable rows={board.stock} movementFields={inventoryMovementFields()} />}
    </ReadOnlyPage>
  );
}
