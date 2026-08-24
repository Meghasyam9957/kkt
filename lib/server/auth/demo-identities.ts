import '@/lib/server/only';
/**
 * DEMO IDENTITIES.
 *
 * Four fictional accounts so the platform can be demonstrated end to end — one per role
 * that has something distinct to show, plus a second investor whose figures differ from
 * the first so isolation is verifiable by eye rather than on trust.
 *
 * **No passwords exist here, and none should.** In a demonstration environment running on
 * fictional data, a password protects nothing and a hard-coded one is a habit that
 * eventually escapes into production. Demo sign-in is an identity *chooser*: pick who you
 * are demonstrating as. When Supabase is configured — including for the demo project —
 * this path is not used at all and real authentication applies, with credentials set
 * through Supabase's own invitation flow.
 *
 * Every construction point is environment-guarded. A production deployment cannot create
 * this provider, so no configuration mistake can turn "choose an identity" into a way past
 * production authentication.
 */
import {
  AuthenticationError, AuthorizationError, type AuthContext, type AuthProvider,
} from './session';
import type { Role } from '@/lib/shared/roles';
import {
  assertDemoOnly, resolveEnvironment, type ResolvedEnvironment,
} from '@/lib/server/environment/config';
import { DEMO_INVESTOR_A, DEMO_INVESTOR_B } from '@/lib/data/demo/dataset';

export interface DemoIdentity {
  /** Stable key used in the session cookie and the sign-in form. */
  key: string;
  email: string;
  name: string;
  role: Role;
  investorId: string | null;
  /** What this account is for, shown on the chooser so a demo can be narrated. */
  purpose: string;
}

export const DEMO_IDENTITIES: readonly DemoIdentity[] = [
  {
    key: 'admin.demo',
    email: 'admin.demo@srivillu.demo',
    name: 'Demo Administrator',
    role: 'ADMIN',
    investorId: null,
    purpose: 'Full internal read access: dashboard, finance, investors, analytics, audit.',
  },
  {
    key: 'operations.demo',
    email: 'operations.demo@srivillu.demo',
    name: 'Demo Operations Manager',
    role: 'OPERATIONS',
    investorId: null,
    purpose: 'Day-to-day running. No financial figures and no investor screens at all.',
  },
  {
    key: 'investor.demo.a',
    email: 'investor.demo.a@srivillu.demo',
    name: 'Investor Demo A',
    role: 'INVESTOR',
    investorId: DEMO_INVESTOR_A,
    purpose: '40% participation, ₹12,00,000 invested. Sees only their own position.',
  },
  {
    key: 'investor.demo.b',
    email: 'investor.demo.b@srivillu.demo',
    name: 'Investor Demo B',
    role: 'INVESTOR',
    investorId: DEMO_INVESTOR_B,
    purpose: '35% participation, ₹10,50,000 invested. Different figures from Investor A.',
  },
] as const;

export function findDemoIdentity(key: string | null | undefined): DemoIdentity | null {
  if (!key) return null;
  return DEMO_IDENTITIES.find((identity) => identity.key === key) ?? null;
}

/** The cookie carrying the chosen demo identity. httpOnly — script cannot read or set it. */
export const DEMO_SESSION_COOKIE = 'srivillu_demo_identity';

/**
 * Resolves a chosen demo identity into an AuthContext.
 *
 * It mirrors `SupabaseAuthProvider` in the one respect that matters: role and investor id
 * come from the stored identity record, never from the presented value. The cookie is a
 * lookup key and nothing more, so a tampered cookie is simply an unknown key — it cannot
 * assert a role or an investor id.
 */
export class DemoAuthProvider implements AuthProvider {
  constructor(resolved: ResolvedEnvironment = resolveEnvironment()) {
    // Construction itself is the guard. There is no production code path to a demo login.
    assertDemoOnly('Demo identity sign-in', resolved);
  }

  async resolve(token: string | null | undefined): Promise<AuthContext> {
    if (!token) throw new AuthenticationError('Missing session token');

    const identity = findDemoIdentity(token);
    if (!identity) throw new AuthenticationError('Invalid or expired session');

    // Same defence in depth as production: an investor with no scope must never reach a
    // query layer that would otherwise return everything.
    if (identity.role === 'INVESTOR' && !identity.investorId) {
      throw new AuthorizationError('Investor account is missing its investor mapping');
    }

    return {
      userId: `demo:${identity.key}`,
      email: identity.email,
      role: identity.role,
      investorId: identity.role === 'INVESTOR' ? identity.investorId : null,
      status: 'ACTIVE',
    };
  }
}
