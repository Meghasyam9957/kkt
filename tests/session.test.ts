/**
 * SHELL SESSION SUITE — who the rendered pages believe they are talking to.
 *
 * The rule under test is narrow and important: **production has no authentication path
 * that does not go through Supabase.** No demo identity, no anonymous fallback, no default
 * administrator. If Supabase is missing, production fails rather than rendering.
 *
 * Demo is allowed to be friendlier, because everything behind it is fictional — but only
 * demo, and only when its own Supabase project is absent.
 *
 * Authorisation itself is not re-tested here; that is the RBAC suite's job. What is tested
 * is that role and investor identity arrive from the account record rather than from
 * anything the caller supplies.
 */
import { describe, it, expect } from 'vitest';
import {
  getShellSession, supabaseStatus, sessionCookieName, authMode, AuthNotConfiguredError,
} from '@/lib/server/auth/shell-session';
import { InMemoryAuthProvider, AuthorizationError, AuthenticationError } from '@/lib/server/auth/session';
import { DEMO_SESSION_COOKIE, DEMO_IDENTITIES } from '@/lib/server/auth/demo-identities';
import { resolveEnvironment } from '@/lib/server/environment/config';
import { DEMO_INVESTOR_A } from '@/lib/data/demo/dataset';

const DEMO_NO_SUPABASE = { APP_ENV: 'demo' };
const PRODUCTION_NO_SUPABASE = { APP_ENV: 'production' };
const DEMO_WITH_SUPABASE = {
  APP_ENV: 'demo',
  DEMO_SUPABASE_URL: 'https://srivillu-demo.supabase.invalid',
  DEMO_SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role',
};
const PRODUCTION_WITH_SUPABASE = {
  APP_ENV: 'production',
  PRODUCTION_SUPABASE_URL: 'https://srivillu-production.supabase.invalid',
  PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: 'production-service-role',
};

const provider = new InMemoryAuthProvider([
  { userId: 'u-1', email: 'ops.manager@srivillu.test', role: 'OPERATIONS', token: 'tok-ops' },
  { userId: 'u-2', email: 'owner@srivillu.test', role: 'SUPER_ADMIN', token: 'tok-super' },
  { userId: 'u-3', email: 'a@srivillu.test', role: 'INVESTOR', investorId: 'INV-001', token: 'tok-inv' },
  { userId: 'u-4', email: 'gone@srivillu.test', role: 'ADMIN', token: 'tok-suspended', status: 'SUSPENDED' },
  { userId: 'u-5', email: 'broken@srivillu.test', role: 'INVESTOR', investorId: null, token: 'tok-unmapped' },
]);

describe('shell session · which authenticator applies', () => {
  it('demo without Supabase uses the identity chooser', () => {
    expect(authMode(DEMO_NO_SUPABASE)).toBe('demo-identity');
  });

  it('demo WITH Supabase uses Supabase — the chooser is not a preference', () => {
    expect(authMode(DEMO_WITH_SUPABASE)).toBe('supabase');
  });

  it('production always uses Supabase', () => {
    expect(authMode(PRODUCTION_WITH_SUPABASE)).toBe('supabase');
    expect(authMode(PRODUCTION_NO_SUPABASE)).toBe('supabase');
  });

  it('production without Supabase refuses to resolve a session at all', async () => {
    // The failure this prevents: real business data served to an unauthenticated caller.
    await expect(getShellSession({ env: PRODUCTION_NO_SUPABASE }))
      .rejects.toBeInstanceOf(AuthNotConfiguredError);
    await expect(getShellSession({ env: PRODUCTION_NO_SUPABASE }))
      .rejects.toThrow(/PRODUCTION_SUPABASE_URL/);
  });

  it('production reports its own project status, not the demo project', () => {
    const status = supabaseStatus(PRODUCTION_NO_SUPABASE);
    expect(status.environment).toBe('PRODUCTION');
    expect(status.missing).toEqual(['PRODUCTION_SUPABASE_URL', 'PRODUCTION_SUPABASE_SERVICE_ROLE_KEY']);
  });

  it('the status object never carries the secret it reports on', () => {
    const status = supabaseStatus(PRODUCTION_WITH_SUPABASE);
    expect(status.configured).toBe(true);
    expect(JSON.stringify(status)).not.toContain('production-service-role');
  });

  it('the session cookie name is environment-scoped, then global, then a default', () => {
    expect(sessionCookieName(DEMO_NO_SUPABASE)).toBe('sb-access-token');
    expect(sessionCookieName({ ...DEMO_NO_SUPABASE, DEMO_SUPABASE_AUTH_COOKIE: 'sb-demo-auth-token' }))
      .toBe('sb-demo-auth-token');
    expect(sessionCookieName({ ...PRODUCTION_NO_SUPABASE, PRODUCTION_SUPABASE_AUTH_COOKIE: 'sb-prod-auth-token' }))
      .toBe('sb-prod-auth-token');
  });
});

describe('shell session · demo identity sign-in', () => {
  const signedInAs = (identity: string | null) =>
    getShellSession({ env: DEMO_NO_SUPABASE, readToken: async () => identity });

  it('resolves the chosen demonstration account', async () => {
    const session = await signedInAs('admin.demo');
    expect(session.role).toBe('ADMIN');
    expect(session.name).toBe('Demo Administrator');
    expect(session.demo).toBe(true);
  });

  it('carries the investor scope for an investor account, from the record', async () => {
    const session = await signedInAs('investor.demo.a');
    expect(session.role).toBe('INVESTOR');
    expect(session.investorId).toBe(DEMO_INVESTOR_A);
  });

  it('gives operations no investor scope', async () => {
    expect((await signedInAs('operations.demo')).investorId).toBeNull();
  });

  it('a tampered cookie is simply an unknown key — it cannot assert a role', async () => {
    await expect(signedInAs('{"role":"SUPER_ADMIN","investorId":"INV-002"}'))
      .rejects.toBeInstanceOf(AuthenticationError);
    await expect(signedInAs('admin.demo.super')).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('no cookie means signed out, not a default administrator', async () => {
    await expect(signedInAs(null)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('the demo cookie is a distinct name from the Supabase one', () => {
    expect(DEMO_SESSION_COOKIE).not.toBe(sessionCookieName(DEMO_NO_SUPABASE));
    expect(DEMO_IDENTITIES.length).toBe(4);
  });
});

describe('shell session · identity comes from the account record', () => {
  const signedInAs = (token: string | null) =>
    getShellSession({ provider, readToken: async () => token, env: DEMO_WITH_SUPABASE });

  it('resolves the role stored against the verified user', async () => {
    const session = await signedInAs('tok-ops');
    expect(session.role).toBe('OPERATIONS');
    expect(session.email).toBe('ops.manager@srivillu.test');
    expect(session.demo).toBe(false);
  });

  it('carries the investor scope for investor accounts, and only for them', async () => {
    expect((await signedInAs('tok-inv')).investorId).toBe('INV-001');
    expect((await signedInAs('tok-ops')).investorId).toBeNull();
  });

  it('a token claiming a different role changes nothing — it is only a lookup key', async () => {
    await expect(signedInAs('{"role":"SUPER_ADMIN","investorId":"INV-002"}'))
      .rejects.toBeInstanceOf(AuthenticationError);
  });

  it('rejects a missing session rather than degrading to a demo view', async () => {
    await expect(signedInAs(null)).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('refuses a suspended account', async () => {
    await expect(signedInAs('tok-suspended')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses an investor account with no investor mapping', async () => {
    // An investor with no scope reaching a query layer would be handed everything.
    await expect(signedInAs('tok-unmapped')).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('derives a readable display name without inventing a profile', async () => {
    expect((await signedInAs('tok-ops')).name).toBe('Ops Manager');
    expect((await signedInAs('tok-super')).name).toBe('Owner');
  });
});

describe('shell session · environment resolution is shared, not re-derived', () => {
  it('accepts a pre-resolved environment so a request resolves it once', async () => {
    const resolved = resolveEnvironment(DEMO_NO_SUPABASE);
    const session = await getShellSession({
      resolved, env: DEMO_NO_SUPABASE, readToken: async () => 'operations.demo',
    });
    expect(session.role).toBe('OPERATIONS');
  });
});
