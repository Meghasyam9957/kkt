import { ReadOnlyPage, type SearchParams } from '@/lib/shared/page-helpers';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatPercent, formatMonthLong } from '@/lib/shared/format';
import type { PropertyBoardRow } from '@/lib/data/providers/types';

export const metadata = { title: 'Properties — Srivillu Home Stays' };

export default async function PropertiesPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  return (
    <ReadOnlyPage
      capability="properties.read"
      title="Properties"
      description="The permanent unit register. Performance figures follow the reporting month; direct costs only, since shared costs are not allocated per unit."
      searchParams={params}
      filters={['month', 'property']}
      fetcher={(provider, filters) => provider.getProperties(filters)}
    >
      {(rows, envelope) => <PropertyTable rows={rows} period={envelope.meta.period} />}
    </ReadOnlyPage>
  );
}

function PropertyTable({ rows, period }: { rows: PropertyBoardRow[]; period: string }) {
  const columns: Column<PropertyBoardRow>[] = [
    { key: 'id', header: 'Property ID', render: (r) => <strong>{r.propertyId}</strong> },
    { key: 'unit', header: 'Unit', render: (r) => r.unit },
    { key: 'bhk', header: 'Type', render: (r) => r.bhkType || '—' },
    { key: 'floor', header: 'Floor', numeric: true, render: (r) => r.floor },
    { key: 'bedrooms', header: 'Bedrooms', numeric: true, render: (r) => r.bedrooms },
    { key: 'guests', header: 'Max guests', numeric: true, render: (r) => r.maxGuests || '—' },
    {
      key: 'listing', header: 'Listing',
      render: (r) => {
        const status = r.listingStatus || '—';
        return <StatusPill tone={status === 'Live' ? 'good' : 'neutral'}>{status}</StatusPill>;
      },
    },
    { key: 'occupancy', header: 'Occupancy', numeric: true, render: (r) => formatPercent(r.occupancyPct, 0) },
    { key: 'revenue', header: 'Net revenue', numeric: true, render: (r) => formatCurrency(r.netRevenue) },
    {
      key: 'profit', header: 'Profit', numeric: true,
      render: (r) => <span className={r.profit < 0 ? 'sv-negative' : ''}>{formatCurrency(r.profit)}</span>,
    },
  ];

  return (
    <Card>
      <CardHeader
        title="Unit register"
        subtitle={`Master data with performance for ${formatMonthLong(period)}. Editing arrives with write access in a later phase.`}
      />
      <CardBody className="sv-card__body--flush">
        <DataTable
          columns={columns} rows={rows} caption="Property register"
          getRowKey={(r) => r.propertyId}
          emptyTitle="No properties match this filter"
          emptyMessage="Clear the property filter to see all four units."
        />
      </CardBody>
    </Card>
  );
}
