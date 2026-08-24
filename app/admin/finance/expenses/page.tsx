import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { LedgerTable } from '@/components/pages/LedgerPage';
import { NewRecordButton } from '@/components/mutations/actions';
import { expenseFields } from '@/lib/server/api/form-fields';
import { getDataProvider } from '@/lib/data/providers';

export const metadata = { title: 'Expenses — Srivillu Home Stays' };

/**
 * The "+ New Expense" flow. An async server component so the property options come from
 * the provider AFTER the page's capability check has passed — it renders inside
 * ReadOnlyPage, never before it.
 */
async function NewExpenseAction() {
  const propertyIds = await getDataProvider().getPropertyIds();
  return (
    <NewRecordButton
      label="+ New Expense"
      title="Record an expense"
      endpoint="/api/expenses"
      fields={expenseFields(propertyIds)}
      submitLabel="Record expense"
      successTemplate="{id} recorded — the P&L reflects it on the next refresh."
      idField="ExpenseID"
      wide
    />
  );
}

export default async function ExpensesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      financial="financial"
      capability="expenses.read"
      title="Expenses"
      description="Operating expenses for the selected month. CAPEX is recorded separately and never reaches operating profit."
      searchParams={params}
      filters={['month', 'property']}
      fetcher={(provider, f) => provider.getExpenses(f)}
      actions={<NewExpenseAction />}
    >
      {(rows) => <LedgerTable rows={rows} kind="expense" caption="Expenses ledger" />}
    </ReadOnlyPage>
  );
}
