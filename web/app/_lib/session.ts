// Shared-password gate, stateless. One password for the whole documentation team.
//
// No auth framework (CONTRACT §8). The session cookie carries the hex
// HMAC-SHA256 of a fixed string keyed by DASHBOARD_PASSWORD, so the server
// can re-derive and compare it without storing anything. Rotating the password
// invalidates every outstanding cookie, which is the intended behaviour.
//
// Web Crypto (not node:crypto) so the identical code runs in middleware and in
// the Node route handler. `_lib` is a private folder — Next never routes it.

export const SESSION_COOKIE = 'docloop_session';

/** Fixed, non-secret. The secret is the HMAC key. */
const SESSION_MESSAGE = 'docloop-v1';

/** Seven days. There is no server-side store to expire, so the cookie is the clock. */
export const SESSION_MAX_AGE = 60 * 60 * 24 * 7;

export async function sessionToken(password: string): Promise<string> {
  const bytes = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    bytes.encode(password),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, bytes.encode(SESSION_MESSAGE));
  let hex = '';
  for (const b of new Uint8Array(sig)) hex += b.toString(16).padStart(2, '0');
  return hex;
}

/**
 * Compares without returning early on the first differing character. Both
 * arguments here are fixed-length hex digests, so length is not a secret;
 * the length term is folded into the accumulator rather than short-circuited
 * so the loop shape never depends on the comparison.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    // charCodeAt past the end is NaN; `| 0` makes that a stable 0.
    diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  }
  return diff === 0;
}
