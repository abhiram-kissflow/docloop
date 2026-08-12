// Which paths the shared-password gate lets through untouched.
//
// This is an allowlist, and it is the whole decision: anything not named here
// is private. A page added later is therefore protected by default, which is
// the opposite of what a blocklist would do.
//
// Kept in its own module so it can be exercised directly, without booting Next.

/** Public paths, exact match. Each is here for a stated reason. */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  // The gate itself — without these the login page cannot render or submit.
  '/login',
  '/api/login',

  // GitHub cannot log in. These carry their own HMAC or bearer auth (CONTRACT §3).
  '/api/hooks/github',
  '/api/hooks/intercom',
  '/api/hooks/generic',

  // The Mac worker calls these with WORKER_API_KEY as a bearer token (CONTRACT §3).
  '/api/jobs',
  '/api/results',
  '/api/ingest/patterns',
  '/api/articles',
  // POST /api/suggestions — B1 writing article-linked suggestions. EXACT match only, which is
  // what keeps /api/suggestions/[id] (approve/dismiss) private: PUBLIC_PATHS is a Set of exact
  // paths, never a prefix list. If this ever becomes a prefix, the approve/dismiss action opens
  // to anyone with the URL. It is the one entry here whose sibling path must stay gated.
  '/api/suggestions',

  '/favicon.ico',
  '/robots.txt',
]);

/** Public prefixes. Framework assets only — the login page needs its CSS and fonts. */
export const PUBLIC_PREFIXES: readonly string[] = ['/_next/'];

// Deliberately NOT public: /api/suggestions/[id]. It is the approve/dismiss
// action and has no bearer auth of its own, because it was assumed to be
// same-origin. Left open, anyone holding the URL could decide a suggestion.

export function isPublicPath(pathname: string): boolean {
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname;
  if (PUBLIC_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
}
