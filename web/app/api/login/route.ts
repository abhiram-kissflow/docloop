import { NextResponse } from 'next/server';
import { SESSION_COOKIE, SESSION_MAX_AGE, constantTimeEqual, sessionToken } from '@/app/_lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Accepts the fetch the login form makes (JSON) and the native form POST it
// falls back to without JavaScript (urlencoded). Same check either way.
type Reason = 'unconfigured' | 'empty' | 'bad';

function reject(isForm: boolean, req: Request, reason: Reason, status: number) {
  if (!isForm) return NextResponse.json({ error: reason }, { status });
  const url = new URL('/login', req.url);
  url.searchParams.set('error', reason);
  return NextResponse.redirect(url, 303);
}

export async function POST(req: Request) {
  const isForm = (req.headers.get('content-type') ?? '').includes('form');

  let submitted = '';
  try {
    if (isForm) {
      submitted = String((await req.formData()).get('password') ?? '');
    } else {
      const body: unknown = await req.json();
      const value = (body as { password?: unknown } | null)?.password;
      submitted = typeof value === 'string' ? value : '';
    }
  } catch {
    submitted = '';
  }

  const password = process.env.DASHBOARD_PASSWORD;
  // Fail closed, exactly as the middleware does: no password configured is a
  // refusal, never a bypass.
  if (!password) return reject(isForm, req, 'unconfigured', 503);
  if (!submitted) return reject(isForm, req, 'empty', 400);

  // Both sides are hashed before comparison, so the compare runs over two
  // fixed-length hex digests and neither the password's length nor its prefix
  // leaks through the timing of the loop.
  const expected = await sessionToken(password);
  const offered = await sessionToken(submitted);
  if (!constantTimeEqual(offered, expected)) return reject(isForm, req, 'bad', 401);

  const res = isForm
    ? NextResponse.redirect(new URL('/', req.url), 303)
    : NextResponse.json({ ok: true });

  // `secure` is set for every real deployment and dropped ONLY for a plaintext localhost
  // connection. Safari and Firefox refuse to STORE a Secure cookie over http://, so with it
  // hardcoded the login succeeds, the browser silently discards the cookie, the redirect lands
  // back on /login, and it is indistinguishable from a wrong password. Chrome special-cases
  // localhost, which is why this only reproduces in some browsers.
  // This weakens nothing in production: Vercel is HTTPS-only, so `secure` is always true there.
  const url = new URL(req.url);
  const isPlainLocalhost =
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]') &&
    req.headers.get('x-forwarded-proto') !== 'https';

  res.cookies.set({
    name: SESSION_COOKIE,
    value: expected,
    httpOnly: true,
    secure: !isPlainLocalhost,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_MAX_AGE,
  });

  return res;
}
