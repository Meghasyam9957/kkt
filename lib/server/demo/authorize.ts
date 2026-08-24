import '@/lib/server/only';
/**
 * AUTHORISATION FOR DEMONSTRATION CONTROLS.
 *
 * Two independent gates, and both must pass:
 *
 *   ENVIRONMENT — the operation must be demo-only. This is checked first and it is not a
 *   permission: production has no scenario switch and no reset, so there is nothing for a
 *   role to be granted. A production request fails here regardless of who is asking.
 *
 *   CAPABILITY — the caller must hold `demo.control`, which management roles have and
 *   OPERATIONS and INVESTOR do not. An operations login must not be able to reset the
 *   dataset mid-demonstration, and an investor login must not see these controls exist.
 *
 * Order matters. Checking the environment first means a production deployment never even
 * evaluates who is asking, so there is no path where a sufficiently privileged account
 * could reach a destructive demo operation against real data.
 */
import { getShellSession } from '@/lib/server/auth/shell-session';
import { AuthenticationError, AuthorizationError } from '@/lib/server/auth/session';
import { roleHasCapability } from '@/lib/shared/roles';
import {
  resolveEnvironment, assertDemoOnly, type ResolvedEnvironment,
} from '@/lib/server/environment/config';
import type { ShellSession } from '@/lib/server/auth/shell-session';

export interface DemoAuthorization {
  resolved: ResolvedEnvironment;
  session: ShellSession;
}

/**
 * Authorise a demonstration operation, or throw.
 *
 * Throws `DemoOnlyOperationError` in production, `AuthenticationError` when signed out and
 * `AuthorizationError` when the role does not hold `demo.control` — three distinct
 * failures so the caller can answer with the right status code.
 */
export async function authorizeDemoOperation(operation: string): Promise<DemoAuthorization> {
  const resolved = resolveEnvironment();
  assertDemoOnly(operation, resolved);

  const session = await getShellSession({ resolved });
  if (!roleHasCapability(session.role, 'demo.control')) {
    throw new AuthorizationError('Not authorized');
  }
  return { resolved, session };
}

export { AuthenticationError, AuthorizationError };
