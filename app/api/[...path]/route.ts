/**
 * API GATEWAY — the thin adapter between HTTP and the guarded router.
 *
 * Everything here is transport: parse the request, find the session token, dispatch,
 * serialise the response. Authentication, authorization, validation, idempotency,
 * writes, verification and audit all happen inside `lib/server` — this file contains
 * no business logic and (by test-enforced rule) no sheet write call.
 *
 * `/api/session` and `/api/demo` have their own dedicated handlers and never reach
 * this catch-all — Next.js routes static segments before dynamic ones.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { cookies } from 'next/headers';
import { getApiRouter } from '@/lib/server/api/service';
import { sessionCookieName } from '@/lib/server/auth/shell-session';
import { DEMO_SESSION_COOKIE } from '@/lib/server/auth/demo-identities';

export const dynamic = 'force-dynamic';

async function dispatch(request: NextRequest, params: { path: string[] }): Promise<Response> {
  const path = `/api/${params.path.join('/')}`;

  // The session travels as a cookie (browser) or an Authorization header (API client).
  // The guard's extractToken reads the header, so the cookie is lifted into it here —
  // one resolution path inside the guard, not two.
  const jar = cookies();
  const token = jar.get(DEMO_SESSION_COOKIE)?.value ?? jar.get(sessionCookieName())?.value ?? null;
  const authHeader = request.headers.get('authorization') ?? (token ? `Bearer ${token}` : undefined);

  let body: unknown;
  if (request.method !== 'GET') {
    try {
      body = await request.json();
    } catch {
      body = {};
    }
  }

  const query: Record<string, string> = {};
  request.nextUrl.searchParams.forEach((value, key) => { query[key] = value; });

  const response = await getApiRouter().dispatch({
    method: request.method,
    path,
    query,
    headers: { ...(authHeader ? { authorization: authHeader } : {}) },
    body,
    requestId: crypto.randomUUID(),
  });

  return NextResponse.json(response.body, { status: response.status });
}

export async function GET(request: NextRequest, ctx: { params: { path: string[] } }) {
  return dispatch(request, ctx.params);
}
export async function POST(request: NextRequest, ctx: { params: { path: string[] } }) {
  return dispatch(request, ctx.params);
}
export async function PATCH(request: NextRequest, ctx: { params: { path: string[] } }) {
  return dispatch(request, ctx.params);
}
// No DELETE export, deliberately: the registry declares none, and this gateway does not
// even accept the verb — removal is a status transition decided by a person.
