import '@/lib/server/only';
/**
 * PAGE AUTHORISATION.
 *
 * Hiding a navigation entry is a convenience. It is not a control, and until this module
 * existed it was the only thing standing between an operations login and the P&L: the
 * menu did not show the link, but typing the URL rendered the page.
 *
 * Every page under `/admin` now declares the capability it needs and is refused without
 * it. The declaration lives at the page, next to what it renders, so adding a screen means
 * stating who may see it — and a test fails if a page forgets.
 *
 * This sits alongside, not instead of, the API guard. A page renders data fetched
 * server-side; the API guard protects the same data when fetched directly. Both check.
 */
import { redirect } from 'next/navigation';
import { getShellSession, type ShellSession } from './shell-session';
import { AuthenticationError, AuthorizationError } from './session';
import { roleHasCapability, type Capability } from '@/lib/shared/roles';
import { requireTenant, type TenantContext } from '@/lib/server/tenant/context';
import { resolveEnvironment, type ResolvedEnvironment } from '@/lib/server/environment/config';

export interface PageAccess {
  session: ShellSession;
  allowed: boolean;
  capability: Capability;
  /**
   * The tenant this request acts in, ready to hand to `getDataProvider`.
   *
   * Built here so a page never assembles one itself: there is exactly one path from a
   * session to a tenant context, and it starts at the guard that already resolved the
   * session. Absent or malformed means the page cannot read business data at all, which
   * `requireTenant` turns into a refusal rather than a widening.
   */
  tenant: TenantContext;
}

/**
 * Resolve the session and decide whether this role may see the page.
 *
 * A signed-out visitor is redirected to sign-in. A signed-IN visitor without the capability
 * is not redirected — they are told plainly that the screen is not part of their role.
 * Bouncing an authenticated operations manager to a login form would suggest their session
 * had expired, which is both untrue and unhelpful.
 */
export async function checkPageAccess(
  capability: Capability,
  options: { resolved?: ResolvedEnvironment } = {},
): Promise<PageAccess> {
  const resolved = options.resolved ?? resolveEnvironment();

  let session: ShellSession;
  try {
    session = await getShellSession({ resolved });
  } catch (error) {
    if (error instanceof AuthenticationError || error instanceof AuthorizationError) {
      redirect('/signin');
    }
    throw error;
  }

  const tenant = requireTenant(session, 'checkPageAccess');
  return { session, tenant, allowed: roleHasCapability(session.role, capability), capability };
}

/**
 * The tenant for THIS request, for a server component that has no `PageAccess` in hand.
 *
 * Resolved from the session, exactly as `checkPageAccess` does. There is no argument to
 * poison and no branch that could widen: a caller with no tenant gets an exception,
 * never everyone's data.
 *
 * DELIBERATELY NOT MEMOISED. React's `cache` is not exported by the stable React this
 * project runs, and a module-level memo would be worse than the cost it saves: it is
 * shared by every request the process serves, which is precisely the bug this milestone
 * exists to remove. So a page with a child action component resolves the session twice —
 * one extra cookie read in demo, one extra token verification against Supabase in live.
 * Making that once per request needs a genuinely request-scoped mechanism
 * (AsyncLocalStorage, or React's `cache` when this upgrades); it is recorded as such
 * rather than approximated with something that would leak across requests.
 */
export async function requireTenantContext(): Promise<TenantContext> {
  const session = await getShellSession();
  return requireTenant(session, 'requireTenantContext');
}
