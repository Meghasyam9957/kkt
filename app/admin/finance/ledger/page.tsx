import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { financeServiceFor } from '@/lib/server/api/service';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import {
  billView, receivableView, vendorView, positionView,
  type FinanceBillView, type FinanceReceivableView, type FinanceVendorView,
} from '@/lib/server/finance/projections';

export const metadata = { title: 'Finance Ledger — MAKAM Home Stays' };

/**
 * THE FINANCE LEDGER — payables, receivables and the vendor master.
 *
 * Deliberately narrow, and the description on screen says so. This is not the P&L and not
 * the cash position: it is what the business owes, what it is owed, and what has actually
 * been settled through this ledger. Revenue, expenses and the cash journal keep their
 * authority in the workbook, and the operating result comes from 10_MONTHLY_PNL — a
 * second answer computed here would be a second answer.
 *
 * Every figure is money in minor units, formatted at the point of display and never
 * before, so nothing on this page has been rounded into something that cannot be added up
 * again.
 */
export default async function FinanceLedgerPage() {
  const access = await checkPageAccess('finance.read');
  if (!access.allowed) {
    return (
      <Card>
        <CardHeader title="Finance ledger" />
        <CardBody>
          <p className="sv-empty">
            The finance ledger is not part of the {access.session.role.toLowerCase().replace('_', ' ')} role.
            Payables, receivables and settlement are held by the finance roles.
          </p>
        </CardBody>
      </Card>
    );
  }

  const service = financeServiceFor();
  const [position, bills, receivables, vendors] = await Promise.all([
    service.position(access.tenant),
    service.billsWithBalances(access.tenant, { status: 'OPEN' }),
    service.receivablesWithBalances(access.tenant, { status: 'OPEN' }),
    service.listVendors(access.tenant),
  ]);

  const summary = positionView(position);
  const vendorNames = new Map(vendors.map((v) => [v.id, v.displayName]));

  return (
    <div className="sv-stack">
      <Card>
        <CardHeader
          title="Finance ledger"
          subtitle="What the business owes, what it is owed, and what has settled through this ledger. Not the P&amp;L — the operating result is calculated by the workbook."
        />
        <CardBody>
          <dl className="sv-kpi-row">
            <Figure
              label="Owed to suppliers"
              value={summary.payablesOutstanding.minor}
              note={`${summary.openBills} open ${summary.openBills === 1 ? 'bill' : 'bills'}`}
              alert={summary.overdueBills > 0 ? `${summary.overdueBills} overdue` : null}
            />
            <Figure
              label="Owed to the business"
              value={summary.receivablesOutstanding.minor}
              note={`${summary.openReceivables} open ${summary.openReceivables === 1 ? 'item' : 'items'}`}
              alert={summary.overdueReceivables > 0 ? `${summary.overdueReceivables} overdue` : null}
            />
            <Figure label="Settled out" value={summary.settledOut.minor} note="Posted payments" alert={null} />
            <Figure label="Settled in" value={summary.settledIn.minor} note="Posted receipts" alert={null} />
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Payables" subtitle="Vendor bills with an outstanding balance." />
        <CardBody>
          {bills.length === 0 ? (
            <p className="sv-empty">
              No open bills. Nothing is outstanding to a supplier — this is a settled
              position, not missing data.
            </p>
          ) : (
            <DataTable
              caption="Open vendor bills"
              rows={bills.map(billView)}
              columns={billColumns(vendorNames)}
              getRowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="Receivables"
          subtitle="Amounts owed to the business. OTA payouts are not shown here — the workbook tracks those against the booking."
        />
        <CardBody>
          {receivables.length === 0 ? (
            <p className="sv-empty">No open receivables. Nobody currently owes the business money.</p>
          ) : (
            <DataTable
              caption="Open receivables"
              rows={receivables.map(receivableView)}
              columns={receivableColumns}
              getRowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader title="Vendors" subtitle="The supplier master these bills are raised against." />
        <CardBody>
          {vendors.length === 0 ? (
            <p className="sv-empty">
              No vendors registered yet. A bill is raised against a vendor, so the first
              vendor comes before the first bill.
            </p>
          ) : (
            <DataTable
              caption="Vendors"
              rows={vendors.map(vendorView)}
              columns={vendorColumns}
              getRowKey={(row) => row.id}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Figure(
  { label, value, note, alert }:
  { label: string; value: number; note: string; alert: string | null },
) {
  return (
    <div className="sv-kpi">
      <dt className="sv-kpi__label">{label}</dt>
      {/* Minor units → rupees at the last possible moment, and nowhere else. */}
      <dd className="sv-kpi__value">{formatCurrency(value / 100, true)}</dd>
      <p className="sv-kpi__note">
        {note}
        {alert ? <> · <StatusPill tone="warn">{alert}</StatusPill></> : null}
      </p>
    </div>
  );
}

function billColumns(vendorNames: Map<string, string>): Column<FinanceBillView>[] {
  return [
    { key: 'reference', header: 'Reference', render: (r) => r.reference },
    { key: 'vendor', header: 'Vendor', render: (r) => vendorNames.get(r.vendorId) ?? '—' },
    { key: 'billDate', header: 'Dated', render: (r) => formatDateShort(r.billDate) },
    { key: 'dueDate', header: 'Due', render: (r) => (r.dueDate ? formatDateShort(r.dueDate) : 'Not agreed') },
    { key: 'attribution', header: 'Attributed to', render: (r) => r.attribution.propertyId ?? 'The business' },
    { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatCurrency(r.balance.amount.minor / 100, true) },
    { key: 'settled', header: 'Settled', numeric: true, render: (r) => formatCurrency(r.balance.settled.minor / 100, true) },
    {
      key: 'outstanding',
      header: 'Outstanding',
      numeric: true,
      render: (r) => (
        r.balance.overpaid
          // Surfaced, never hidden: more settled than owed is an error worth seeing.
          ? <StatusPill tone="warn">Overpaid {formatCurrency(Math.abs(r.balance.outstanding.minor) / 100, true)}</StatusPill>
          : formatCurrency(r.balance.outstanding.minor / 100, true)
      ),
    },
  ];
}

const receivableColumns: Column<FinanceReceivableView>[] = [
  { key: 'reference', header: 'Reference', render: (r) => r.reference },
  { key: 'counterparty', header: 'Owed by', render: (r) => r.counterparty },
  { key: 'issuedDate', header: 'Issued', render: (r) => formatDateShort(r.issuedDate) },
  { key: 'dueDate', header: 'Due', render: (r) => (r.dueDate ? formatDateShort(r.dueDate) : 'Not agreed') },
  { key: 'attribution', header: 'Attributed to', render: (r) => r.attribution.propertyId ?? 'The business' },
  { key: 'amount', header: 'Amount', numeric: true, render: (r) => formatCurrency(r.balance.amount.minor / 100, true) },
  { key: 'outstanding', header: 'Outstanding', numeric: true, render: (r) => formatCurrency(r.balance.outstanding.minor / 100, true) },
];

const vendorColumns: Column<FinanceVendorView>[] = [
  { key: 'displayName', header: 'Vendor', render: (r) => r.displayName },
  { key: 'gstin', header: 'GSTIN', render: (r) => r.gstin ?? '—' },
  { key: 'contactRef', header: 'Contact', render: (r) => r.contactRef ?? '—' },
  {
    key: 'paymentTermsDays',
    header: 'Terms',
    // Null is "not agreed", which is not the same as zero days.
    render: (r) => (r.paymentTermsDays === null ? 'Not agreed' : `Net ${r.paymentTermsDays} days`),
  },
  { key: 'status', header: 'Status', render: (r) => <StatusPill tone={r.status === 'ACTIVE' ? 'good' : 'neutral'}>{r.status === 'ACTIVE' ? 'Active' : 'Inactive'}</StatusPill> },
];
