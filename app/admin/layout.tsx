/**
 * ADMIN LAYOUT — authentication, environment, and one data fetch for the whole shell.
 *
 * Three things happen here and nowhere else:
 *
 *   1. The session is resolved server-side. A signed-out visitor is redirected to sign-in
 *      rather than shown a shell carrying someone else's navigation.
 *   2. The environment is resolved server-side and handed down as a plain fact. No
 *      component works out which system it is in.
 *   3. Filter options and provenance are fetched once, not per page and never per card.
 */
import { redirect } from 'next/navigation';
import { Suspense } from 'react';
import { getDataProvider, isLiveDataEnabled } from '@/lib/data/providers';
import { getShellSession } from '@/lib/server/auth/shell-session';
import { AuthenticationError, AuthorizationError } from '@/lib/server/auth/session';
import { resolveEnvironment, publicEnvironmentInfo } from '@/lib/server/environment/config';
import { AppShell } from '@/components/shell/AppShell';
import { FilterProvider } from '@/components/shell/FilterContext';
import { resolveBrandAssets } from '@/lib/server/brand/assets';
import { demoStatus } from '@/lib/server/demo/store';
import { DEMO_SCENARIO_DESCRIPTORS } from '@/lib/shared/environment';
import { roleHasCapability } from '@/lib/shared/roles';

/**
 * Never statically generated. Every page in this tree depends on the signed-in session and,
 * in demo, on mutable server state — prerendering one would bake in a stranger's view of
 * the application at build time.
 */
export const dynamic = 'force-dynamic';

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const resolved = resolveEnvironment();
  const environment = publicEnvironmentInfo(resolved, !isLiveDataEnabled());

  /*
   * A signed-out visitor gets the sign-in screen, never a rendered shell.
   *
   * Configuration failures are deliberately NOT caught: an unconfigured production
   * deployment must fail loudly rather than redirect into a sign-in it also cannot serve.
   */
  let session;
  try {
    session = await getShellSession({ resolved });
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      redirect('/signin');
    }
    throw error;
  }

  const provider = getDataProvider();
  // Resolved on the server so a present asset renders immediately and an absent one
  // renders the lockup — never a flash of one replaced by the other.
  const brandAssets = resolveBrandAssets();

  const [availableMonths, availablePlatforms, availableProperties, meta] = await Promise.all([
    provider.getAvailableMonths(),
    provider.getPlatforms(),
    provider.getPropertyIds(),
    // Provenance comes FROM the provider rather than being assumed here. Asserting
    // "GOOD" in the layout would let the header claim live data was current when the
    // last fetch had actually failed.
    provider.getSourceMeta(),
  ]);

  /*
   * The bell's count is the number of items on the operations board needing attention —
   * a fact from the provider, never a literal. Only fetched for roles that can act on
   * it (the read is cached, so this costs nothing extra on live data), and a failure
   * here degrades to "no badge" rather than taking the whole shell down: the board
   * itself still reports its error state on its own screen.
   */
  // The month the source says it is presenting, not simply the last one with data — so
  // the headline and the operational panel always describe the same period.
  const defaultMonth = meta.period || availableMonths[availableMonths.length - 1] || '';

  let alertCount = 0;
  if (roleHasCapability(session.role, 'operations.view')) {
    try {
      const ops = await provider.getOperations({ month: defaultMonth });
      alertCount = ops.data?.urgent?.length ?? 0;
    } catch {
      alertCount = 0;
    }
  }

  // Only in demo, and only for a role that could actually change it. Showing an operations
  // manager a control they cannot use is noise; showing it in production is a defect.
  const scenario = resolved.demoControlsPermitted && roleHasCapability(session.role, 'demo.control')
    ? { key: demoStatus().scenario, title: DEMO_SCENARIO_DESCRIPTORS[demoStatus().scenario].title }
    : null;

  return (
    <Suspense fallback={null}>
      <FilterProvider
        defaultMonth={defaultMonth}
        availableMonths={availableMonths}
        availableProperties={availableProperties}
        availablePlatforms={availablePlatforms}
      >
        <AppShell
          user={{ name: session.name, email: session.email, role: session.role }}
          meta={meta}
          environment={environment}
          scenario={scenario}
          alertCount={alertCount}
          brandAssets={brandAssets}
        >
          {children}
        </AppShell>
      </FilterProvider>
    </Suspense>
  );
}
