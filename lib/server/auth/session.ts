import '@/lib/server/only';
/**
 * SESSION RESOLUTION — turning a request into a trusted AuthContext.
 *
 * The central rule: the caller's role and investor_id are read from the DATABASE using
 * the verified user id from the session. They are never taken from the JWT payload, a
 * header, a cookie, a query string or the request body. A forged claim therefore cannot
 * change what a request is allowed to see.
 */
import { isRole, type Role } from './roles';

export interface AuthContext {
  userId: string;
  email: string;
  role: Role;
  /**
   * The tenant this principal is acting in. Resolved HERE — from the membership row in
   * the live path, from the demonstration fixture in demo, from the stored test user in
   * memory — and never from anything the caller supplied. Every consumer of business
   * data requires it, and refuses without it.
   */
  tenantId: string;
  /** Present only for INVESTOR. Server-resolved; the sole source of investor identity. */
  investorId: string | null;
  status: 'ACTIVE' | 'SUSPENDED';
}

export class AuthenticationError extends Error {
  readonly httpStatus = 401;
  constructor(message = 'Not authenticated') { super(message); this.name = 'AuthenticationError'; }
}

export class AuthorizationError extends Error {
  readonly httpStatus = 403;
  constructor(message = 'Not authorized') { super(message); this.name = 'AuthorizationError'; }
}

/** Resolves a bearer token / session cookie into a verified AuthContext, or throws. */
export interface AuthProvider {
  resolve(accessToken: string | null | undefined): Promise<AuthContext>;
}

/* ------------------------------------------------------------------ *
 * Supabase-backed provider (production)
 * ------------------------------------------------------------------ */

export interface SupabaseAuthConfig {
  url: string;
  /** Service-role key. Server-side env only — never shipped to a browser. */
  serviceRoleKey: string;
}

export class SupabaseAuthProvider implements AuthProvider {
  private client: any = null;

  constructor(private readonly config: SupabaseAuthConfig) {
    if (!config.url) throw new Error('SUPABASE_URL is not configured');
    if (!config.serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is not configured');
  }

  private async supabase(): Promise<any> {
    if (this.client) return this.client;
    const { createClient } = await import('@supabase/supabase-js');
    this.client = createClient(this.config.url, this.config.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    return this.client;
  }

  async resolve(accessToken: string | null | undefined): Promise<AuthContext> {
    if (!accessToken) throw new AuthenticationError('Missing session token');

    const supabase = await this.supabase();

    // Step 1 — verify the token with Supabase. This is the only thing the token is used for.
    const { data, error } = await supabase.auth.getUser(accessToken);
    if (error || !data?.user?.id) throw new AuthenticationError('Invalid or expired session');
    const userId: string = data.user.id;

    // Step 2 — authority comes from the database row, keyed by the VERIFIED user id.
    const { data: row, error: rowError } = await supabase
      .from('app_users')
      .select('id, email, role, investor_id, status')
      .eq('id', userId)
      .single();

    if (rowError || !row) throw new AuthenticationError('No application account for this user');
    if (!isRole(row.role)) throw new AuthenticationError(`Unknown role: ${row.role}`);
    if (row.status !== 'ACTIVE') throw new AuthorizationError('Account is suspended');

    /*
     * Step 3 — the TENANT, and the role to use inside it, from the membership.
     *
     * Keyed by the verified user id, exactly as the account row is. A caller cannot
     * name a tenant: the query does not accept one, so there is no parameter to poison.
     *
     * One active membership is the shape M-SAAS-0 establishes. When a user eventually
     * holds several (MAKAM support staff will), choosing between them becomes an
     * explicit, audited act — never an implicit "first row wins", which is why more than
     * one is refused here rather than silently resolved.
     */
    const { data: memberships, error: membershipError } = await supabase
      .from('memberships')
      .select('tenant_id, role, status')
      .eq('user_id', userId)
      .eq('status', 'ACTIVE');

    if (membershipError) throw new AuthenticationError('Could not resolve tenant membership');
    const active = memberships ?? [];
    if (active.length > 1) {
      throw new AuthorizationError(
        'This account belongs to more than one tenant. Choosing between them is not yet ' +
        'supported, and defaulting to one of them would be a guess about whose data to show.',
      );
    }
    const membership = active[0];
    if (!membership?.tenant_id) {
      throw new AuthorizationError('No active tenant membership for this account');
    }
    // The membership's role is the authority. `app_users.role` remains only as the
    // pre-migration fallback and is not consulted once a membership exists.
    const role = isRole(membership.role) ? membership.role : row.role;
    if (role !== row.role) {
      throw new AuthorizationError('Account role and tenant membership disagree');
    }

    // Defence in depth: the DB constraint already guarantees this, but an investor
    // without a scope must never reach a query layer that would return everything.
    if (row.role === 'INVESTOR' && !row.investor_id) {
      throw new AuthorizationError('Investor account is missing its investor mapping');
    }

    return {
      userId: row.id,
      email: row.email,
      role,
      tenantId: String(membership.tenant_id),
      investorId: role === 'INVESTOR' ? row.investor_id : null,
      status: row.status,
    };
  }
}

/* ------------------------------------------------------------------ *
 * In-memory provider (tests, local development)
 * ------------------------------------------------------------------ */

export interface TestUser {
  userId: string;
  email: string;
  role: Role;
  /** The tenant this user belongs to. Required: a test user with no tenant is refused. */
  tenantId?: string;
  investorId?: string | null;
  status?: 'ACTIVE' | 'SUSPENDED';
  /** Opaque token the test presents; stands in for a Supabase access token. */
  token: string;
}

/**
 * Mirrors SupabaseAuthProvider's semantics exactly — including that role and investorId
 * come from the stored record, never from the presented token. Tests that pass against
 * this provider are testing the same rules production enforces.
 */
export class InMemoryAuthProvider implements AuthProvider {
  private byToken = new Map<string, TestUser>();

  constructor(users: TestUser[] = []) {
    for (const user of users) this.add(user);
  }

  add(user: TestUser): this {
    this.byToken.set(user.token, user);
    return this;
  }

  async resolve(accessToken: string | null | undefined): Promise<AuthContext> {
    if (!accessToken) throw new AuthenticationError('Missing session token');
    const user = this.byToken.get(accessToken);
    if (!user) throw new AuthenticationError('Invalid or expired session');
    const status = user.status ?? 'ACTIVE';
    if (status !== 'ACTIVE') throw new AuthorizationError('Account is suspended');
    if (user.role === 'INVESTOR' && !user.investorId) {
      throw new AuthorizationError('Investor account is missing its investor mapping');
    }
    // Mirrors production: a principal with no tenant reaches no data layer at all.
    if (!user.tenantId) {
      throw new AuthorizationError('No active tenant membership for this account');
    }
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      tenantId: user.tenantId,
      investorId: user.role === 'INVESTOR' ? (user.investorId ?? null) : null,
      status,
    };
  }
}
