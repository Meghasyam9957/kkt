/**
 * PROCUREMENT — asking for stock, deciding, ordering, and signing for what arrived.
 *
 * FOUR THINGS THIS SCREEN KEEPS APART, because merging any two of them is how an inventory
 * system starts lying:
 *
 *   a request   somebody asks. Nothing is committed.
 *   an order    the business promises a vendor. Still no stock, still no money owed.
 *   a receipt   something physically arrived. THE ONLY EVENT THAT INCREASES STOCK, and it
 *               moves the workbook by what arrived, never by what was ordered.
 *   a bill      money is owed. NOT HERE. `finance_bills` owns that claim and a person raises
 *               it, because a delivery note and an invoice are different documents that
 *               routinely disagree.
 *
 * PRICES ARE SHOWN ONLY TO A CALLER ENTITLED TO THEM. An operations supervisor sees what was
 * ordered and how much of it — everything needed to receive a delivery — and not what it
 * cost. Where a price exists and is withheld the screen says so, rather than showing a blank
 * that reads as "nothing was agreed".
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { inventoryServiceFor } from '@/lib/server/api/service';
import {
  requestView, purchaseOrderView, type RequestView, type PurchaseOrderView,
} from '@/lib/server/inventory/projections';
import {
  inventoryPageContext, type InventoryPageContext,
} from '@/lib/server/inventory/page-context';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import {
  NewRequestButton, RequestDecisionButton, NewOrderButton, OrderStatusButton,
  ReceiveGoodsButton,
} from '@/components/inventory/ProcurementActions';

export const metadata = { title: 'Procurement — MAKAM Home Stays' };

const REQUEST_TONE: Record<string, Tone> = {
  DRAFT: 'neutral', SUBMITTED: 'info', APPROVED: 'good', REJECTED: 'bad', CANCELLED: 'neutral',
};

const ORDER_TONE: Record<string, Tone> = {
  DRAFT: 'neutral', SUBMITTED: 'info', APPROVED: 'good', SENT: 'info',
  PARTIALLY_RECEIVED: 'warn', RECEIVED: 'good', CANCELLED: 'neutral',
};

export default async function ProcurementPage() {
  const access = await checkPageAccess('procurement.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  let requests: RequestView[];
  let orders: PurchaseOrderView[];
  let context: InventoryPageContext;
  try {
    const service = inventoryServiceFor();
    context = await inventoryPageContext(access.tenant, access.session.role);
    [requests, orders] = await Promise.all([
      service.listRequests(access.tenant).then((rows) => rows.map(requestView)),
      service.listPurchaseOrders(access.tenant)
        .then((rows) => rows.map((po) => purchaseOrderView(po, context.maySeeMoney))),
    ]);
  } catch (error) {
    console.error('[inventory] procurement failed:', error);
    return (
      <>
        <PageHeader title="Procurement" description="Asking, ordering, and what arrived." />
        <Section>
          <ErrorState message="We couldn't read procurement just now. Try again in a moment." />
        </Section>
      </>
    );
  }

  const open = requests.filter((r) => r.status === 'DRAFT' || r.status === 'SUBMITTED');
  const awaitingDelivery = orders.filter(
    (o) => o.status === 'SENT' || o.status === 'PARTIALLY_RECEIVED',
  );

  const requestColumns: Column<RequestView>[] = [
    {
      key: 'what', header: 'Asked for',
      render: (r) => (
        <span>
          {r.lines.map((l) => `${l.quantity} × ${l.itemRef ?? l.description ?? 'something'}`)
            .join(', ')}
        </span>
      ),
    },
    { key: 'property', header: 'For', render: (r) => r.propertyId ?? 'The business' },
    { key: 'priority', header: 'Urgency', render: (r) => r.priority },
    { key: 'reason', header: 'Why', render: (r) => r.reason ?? <span className="sv-muted">—</span> },
    {
      key: 'status', header: 'Status',
      render: (r) => (
        <StatusPill tone={REQUEST_TONE[r.status] ?? 'neutral'}>{r.status.toLowerCase()}</StatusPill>
      ),
    },
    {
      key: 'action', header: 'Next',
      render: (r) => {
        if (r.status === 'DRAFT') {
          return (
            <span className="sv-assigned">
              <RequestDecisionButton
                requestId={r.id} next="SUBMITTED" label="Submit"
                variant="primary"
              />
              <RequestDecisionButton
                requestId={r.id} next="CANCELLED" label="Cancel"
              />
            </span>
          );
        }
        if (r.status === 'SUBMITTED') {
          /*
           * Offered to everyone who can see the row. Whether this person may decide it is
           * the server's answer — including the case where they may decide requests in
           * general but not this one, because they are the person who asked.
           */
          return (
            <span className="sv-assigned">
              <RequestDecisionButton
                requestId={r.id} next="APPROVED" label="Approve"
                variant="primary"
              />
              <RequestDecisionButton
                requestId={r.id} next="REJECTED" label="Reject" variant="danger"
              />
            </span>
          );
        }
        if (r.status === 'APPROVED') {
          return <NewOrderButton context={context} requestId={r.id} label="Order it" />;
        }
        return <span className="sv-muted">Closed.</span>;
      },
    },
  ];

  const orderColumns: Column<PurchaseOrderView>[] = [
    {
      key: 'what', header: 'Ordered',
      render: (o) => (
        <span>
          {o.lines.map((l) => `${l.quantity} × ${l.itemRef ?? l.description ?? 'something'}`)
            .join(', ')}
        </span>
      ),
    },
    {
      key: 'expected', header: 'Expected',
      render: (o) => (o.expectedDate ? formatDateShort(o.expectedDate) : <span className="sv-muted">no date</span>),
    },
    {
      key: 'value', header: 'Agreed', numeric: true,
      render: (o) => {
        if (o.pricesWithheld) {
          // Not blank, and not zero. Those would say "nothing was agreed", which is a
          // different and untrue sentence.
          return <span className="sv-muted">not shown to you</span>;
        }
        const total = o.lines.reduce(
          (sum, l) => sum + (l.expectedUnitPriceMinor ?? 0) * l.quantity, 0,
        );
        if (total === 0) return <span className="sv-muted">no price agreed</span>;
        // Minor units → rupees at the last possible moment, and nowhere else.
        return <span className="numeric">{formatCurrency(total / 100, true)}</span>;
      },
    },
    {
      key: 'status', header: 'Status',
      render: (o) => (
        <StatusPill tone={ORDER_TONE[o.status] ?? 'neutral'}>
          {o.status.toLowerCase().replace('_', ' ')}
        </StatusPill>
      ),
    },
    {
      key: 'action', header: 'Next',
      render: (o) => {
        if (o.status === 'DRAFT') {
          return (
            <OrderStatusButton poId={o.id} next="SUBMITTED" label="Submit"
              variant="primary" />
          );
        }
        if (o.status === 'SUBMITTED') {
          return (
            <span className="sv-assigned">
              <OrderStatusButton poId={o.id} next="APPROVED" label="Approve"
                variant="primary" />
              <OrderStatusButton poId={o.id} next="CANCELLED" label="Cancel"
                variant="danger" />
            </span>
          );
        }
        if (o.status === 'APPROVED') {
          return (
            <OrderStatusButton poId={o.id} next="SENT" label="Mark sent"
              variant="primary" />
          );
        }
        if (o.status === 'SENT' || o.status === 'PARTIALLY_RECEIVED') {
          return (
            <ReceiveGoodsButton
              poId={o.id}
              lines={o.lines.map((l) => ({
                id: l.id,
                label: l.itemRef ?? l.description ?? 'line',
                ordered: l.quantity,
              }))}
            />
          );
        }
        return <span className="sv-muted">Closed.</span>;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Procurement"
        description="A request is a question, an order is a promise, and only a delivery moves stock."
        actions={<NewRequestButton context={context} />}
      />

      <Section>
        <Card>
          <CardHeader title="Where things stand" />
          <CardBody>
            <div className="sv-kpi-grid">
              <Count label="Requests open" value={open.length} />
              <Count label="Orders awaiting delivery" value={awaitingDelivery.length} />
            </div>
            <p className="sv-kpi__note">
              Nothing on this page creates a bill or an expense. Stock arriving and money
              being owed are different claims, and the finance ledger owns the second one.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Requests"
            subtitle="Whoever asked cannot be whoever approves — refused by the server, and by a database constraint underneath it."
          />
          <CardBody>
            <DataTable
              columns={requestColumns}
              rows={requests}
              caption="Purchase requests"
              getRowKey={(r) => r.id}
              emptyTitle="Nobody has asked for anything"
              emptyMessage="A supervisor who finds an item below its reorder level starts here."
            />
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Purchase orders"
            subtitle="A delivery is recorded by what actually arrived. Short deliveries are the ordinary case."
          />
          <CardBody>
            <DataTable
              columns={orderColumns}
              rows={orders}
              caption="Purchase orders"
              getRowKey={(o) => o.id}
              emptyTitle="No orders"
              emptyMessage="An order can follow an approved request, or stand on its own."
            />
          </CardBody>
        </Card>
      </Section>
    </>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <div className="sv-kpi">
      <dt className="sv-kpi__label">{label}</dt>
      <dd className="sv-kpi__value">{value}</dd>
    </div>
  );
}
