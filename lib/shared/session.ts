/**
 * SESSION SHAPE FOR THE UI SHELL.
 *
 * The resolution logic lives server-side in `lib/server/auth/shell-session.ts`, which
 * verifies the Supabase session and reads the role from the database. This module holds
 * only the shape the shell renders and the demo identity used while Supabase is not yet
 * provisioned.
 *
 * This is presentation state. It grants nothing: every API route resolves its own
 * AuthContext server-side (lib/server/auth/session.ts).
 */
import type { Role } from '@/lib/shared/roles';

export interface SessionUser {
  name: string;
  email: string;
  role: Role;
}

const DEMO_ADMIN: SessionUser = {
  name: 'Demo Administrator',
  email: 'admin@srivillu.demo',
  role: 'ADMIN',
};

/**
 * The identity the shell renders while Supabase is unconfigured AND live data is off.
 *
 * It is never used when live data is enabled — `getShellSession()` refuses that
 * combination outright rather than showing real figures to a demo administrator.
 */
export function getSessionUser(): SessionUser {
  return DEMO_ADMIN;
}
