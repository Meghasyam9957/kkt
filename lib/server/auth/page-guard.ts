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
import { resolveEnvironment, type ResolvedEnvironment } from '@/lib/server/environment/config';

export interface PageAccess {
  session: ShellSession;
  allowed: boolean;
  capability: Capability;
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

  return { session, allowed: roleHasCapability(session.role, capability), capability };
}
