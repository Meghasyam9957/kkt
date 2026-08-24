/**
 * SIGN IN / SIGN OUT.
 *
 * Two modes, chosen by the server from the resolved environment — never by the request:
 *
 *   supabase       email and password, verified by Supabase. The only mode production has.
 *   demo-identity  a chooser over four fictional accounts. Demo only, and the environment
 *                  guard means a production build cannot reach this branch at all.
 *
 * The session cookie is httpOnly, so page script can neither read nor forge it, and it
 * carries a lookup key rather than any claim about who the caller is. Role and investor id
 * are always resolved server-side from the identity record.
 */
import { NextResponse } from 'next/server';
import {
  DEMO_SESSION_COOKIE, findDemoIdentity,
} from '@/lib/server/auth/demo-identities';
import { sessionCookieName, authMode } from '@/lib/server/auth/shell-session';
import { resolveEnvironment, assertDemoOnly, requireSupabase } from '@/lib/server/environment/config';

/** Eight hours: long enough for a demonstration or a working session, short enough to expire. */
const SESSION_MAX_AGE = 8 * 60 * 60;

export async function POST(request: Request): Promise<Response> {
  const form = await request.formData();
  const resolved = resolveEnvironment();
  const mode = authMode();
  // `/admin` lands each role on a screen it can actually use (investors on Portfolio,
  // operations on Today). Sending everyone to the financial dashboard greeted investors
  // with "Not available for your role" as their first screen after signing in.
  const nextUrl = new URL('/admin', request.url);

  if (mode === 'demo-identity') {
    // Guard first: in production this throws before any input is looked at.
    assertDemoOnly('Demo identity sign-in', resolved);

    const identity = findDemoIdentity(String(form.get('identity') ?? ''));
    if (!identity) {
      return NextResponse.redirect(new URL('/signin?error=unknown-identity', request.url), 303);
    }

    const response = NextResponse.redirect(nextUrl, 303);
    response.cookies.set(DEMO_SESSION_COOKIE, identity.key, {
      httpOnly: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_MAX_AGE,
      secure: process.env.NODE_ENV === 'production',
    });
    return response;
  }

  /* ---- Supabase password sign-in ---- */
  const credentials = requireSupabase(resolved);
  if (!credentials.anonKey) {
    return NextResponse.redirect(new URL('/signin?error=anon-key-missing', request.url), 303);
  }

  const email = String(form.get('email') ?? '').trim();
  const password = String(form.get('password') ?? '');
  if (!email || !password) {
    return NextResponse.redirect(new URL('/signin?error=missing-credentials', request.url), 303);
  }

  const { createClient } = await import('@supabase/supabase-js');
  // The ANON key is the correct key for a user sign-in. The service-role key is never used
  // to authenticate a person — it would bypass the checks that make the answer meaningful.
  const supabase = createClient(credentials.url, credentials.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error || !data.session?.access_token) {
    // One message for every failure. Distinguishing "no such user" from "wrong password"
    // tells an attacker which addresses are real.
    return NextResponse.redirect(new URL('/signin?error=invalid', request.url), 303);
  }

  const response = NextResponse.redirect(nextUrl, 303);
  response.cookies.set(sessionCookieName(), data.session.access_token, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.min(data.session.expires_in ?? SESSION_MAX_AGE, SESSION_MAX_AGE),
    secure: process.env.NODE_ENV === 'production',
  });
  return response;
}

/** Sign out: clear both cookies, whichever mode is active. */
export async function DELETE(request: Request): Promise<Response> {
  const response = NextResponse.redirect(new URL('/signin', request.url), 303);
  response.cookies.delete(DEMO_SESSION_COOKIE);
  response.cookies.delete(sessionCookieName());
  return response;
}
