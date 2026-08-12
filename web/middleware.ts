import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE, constantTimeEqual, sessionToken } from '@/app/_lib/session';
import { isPublicPath } from '@/app/_lib/gate';

// The gate. One shared password for the whole documentation team, checked
// against a stateless cookie. See app/_lib/gate.ts for what is public and why.
//
// There is deliberately no `export const config = { matcher }`: a matcher is a
// pattern-shaped blocklist, and something that must fail closed should not be
// steered by one. Without a matcher Next runs this on every request, and the
// allowlist in gate.ts is the only thing that opens a door.
//
// Web Crypto rather than node:crypto: this file is compiled for the proxy
// runtime, which has historically been the edge runtime, and crypto.subtle is
// the one HMAC available in both.

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  const offered = req.cookies.get(SESSION_COOKIE)?.value ?? '';

  // Fail closed: an unset password denies everyone. It never means "no gate".
  const allowed = password ? constantTimeEqual(offered, await sessionToken(password)) : false;
  if (allowed) return NextResponse.next();

  // Case-insensitive: /API/… is still gated either way, but it should answer as an API rather
  // than redirecting a machine caller to a login page.
  if (pathname.toLowerCase().startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }

  // No `?next=` round-trip: a return path taken from the query string is an open
  // redirect waiting to happen, and the queue is the only destination anyone wants.
  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  return NextResponse.redirect(url);
}
