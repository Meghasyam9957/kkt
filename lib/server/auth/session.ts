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

    // Defence in depth: the DB constraint already guarantees this, but an investor
    // without a scope must never reach a query layer that would return everything.
    if (row.role === 'INVESTOR' && !row.investor_id) {
      throw new AuthorizationError('Investor account is missing its investor mapping');
    }

    return {
      userId: row.id,
      email: row.email,
      role: row.role,
      investorId: row.role === 'INVESTOR' ? row.investor_id : null,
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
    return {
      userId: user.userId,
      email: user.email,
      role: user.role,
      investorId: user.role === 'INVESTOR' ? (user.investorId ?? null) : null,
      status,
    };
  }
}
