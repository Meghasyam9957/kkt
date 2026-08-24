/**
 * PAGE HELPERS — one place for the read-only page shape every route shares.
 *
 * Keeps the 14 read-only screens consistent: same filter bar, same header, same error
 * handling, and one provider call per page. A page file becomes a description of what to
 * fetch and how to render it, rather than a copy of the same plumbing.
 */
import { Suspense, type ReactNode } from 'react';
import { PageHeader, Section, LoadingBlock, ErrorState } from '@/components/ui/primitives';
import { FilterBar } from '@/components/shell/FilterBar';
import { getDataProvider } from '@/lib/data/providers';
import type { Envelope, ReportFilters, DashboardDataProvider } from '@/lib/data/providers/types';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { DemoAssumptionsNotice } from '@/components/demo/DemoAssumptionsNotice';
import type { Capability } from '@/lib/shared/roles';

export interface SearchParams { month?: string; property?: string; platform?: string }

/** Resolve URL params into the filter shape the provider expects. */
export async function resolveFilters(params: SearchParams): Promise<ReportFilters> {
  const provider = getDataProvider();
  const months = await provider.getAvailableMonths();
  const month = params.month && months.includes(params.month)
    ? params.month
    : months[months.length - 1] ?? '';
  return { month, propertyId: params.property ?? null, platform: params.platform ?? null };
}

/**
 * Standard read-only page: header, filters, then one fetch rendered by `children`.
 * A failed fetch renders an actionable error rather than an empty screen.
 */
export async function ReadOnlyPage<T>({
  title, description, capability, searchParams, fetcher, children,
  filters: filterControls = ['month', 'property', 'platform'],
  showFilters = true,
  financial,
  actions,
}: {
  /**
   * Masthead actions — typically a NewRecordButton opening a write drawer. Rendered only
   * after the capability check passes; the API guard checks again on submit, so this is
   * presentation, not control.
   */
  actions?: ReactNode;
} & {
  title: string;
  description: string;
  /**
   * Set on any screen whose figures depend on the commercial terms. In demo it renders the
   * assumptions notice; in production it renders nothing, because the notice does not exist
   * there.
   */
  financial?: 'financial' | 'investor';
  /**
   * The capability this screen requires. Mandatory: a page that does not say who may see
   * it cannot be rendered, which is what stops a new screen shipping unguarded.
   */
  capability: Capability;
  searchParams: SearchParams;
  fetcher: (provider: DashboardDataProvider, filters: ReportFilters) => Promise<Envelope<T>>;
  children: (data: T, envelope: Envelope<T>) => ReactNode;
  filters?: Array<'month' | 'property' | 'platform'>;
  showFilters?: boolean;
}) {
  // Checked BEFORE any data is fetched. A refused request must not cause a read of figures
  // the caller is not entitled to, even if the response would have been discarded.
  const access = await checkPageAccess(capability);
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  const provider = getDataProvider();
  const filters = await resolveFilters(searchParams);

  let body: ReactNode;
  try {
    const envelope = await fetcher(provider, filters);
    body = children(envelope.data, envelope);
  } catch (error) {
    body = (
      <ErrorState message={
        error instanceof Error
          ? `${error.message} Retry, or check that the data source is configured.`
          : 'Unable to load this page.'
      } />
    );
  }

  return (
    <>
      <PageHeader title={title} description={description} actions={actions} />
      {financial ? <Section><DemoAssumptionsNotice scope={financial} /></Section> : null}
      {showFilters ? (
        <Section>
          <Suspense fallback={<LoadingBlock rows={2} label="Loading filters" />}>
            <FilterBar show={filterControls} />
          </Suspense>
        </Section>
      ) : null}
      <Section>{body}</Section>
    </>
  );
}
