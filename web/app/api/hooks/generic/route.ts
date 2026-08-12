import { insertEvent, json, q } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The catch-all third-party endpoint. Everything that arrives is stored as an event; one shape is
// also acted on — `type: "feature-flag"`, which is the signal a capability just became visible to
// customers without any GitHub release marking the moment (BLUEPRINT §6). That earns a What's New
// draft, because the flag flip IS the launch as far as a user is concerned.
//
// Only `enabled` flags enqueue. A flag turned OFF is a rollback, and announcing one is worse than
// announcing nothing.
//
// Bounded HERE rather than in the worker: this is model-prompt input arriving from an unvetted
// third party, and §6.6 says bound it at the boundary where it lands.
const MAX_DESCRIPTION = 20_000;

const text = (v: unknown, cap = 500): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, cap) : null;

/** A flag payload is actionable only when it names the flag and is not a rollback. */
function isFeatureFlagLaunch(payload: Record<string, unknown>): boolean {
  if (payload?.type !== 'feature-flag') return false;
  if (!text(payload?.flag) && !text(payload?.name)) return false;
  // Absent `enabled` is treated as a launch: most flag services only fire on enable, and demanding
  // the field would silently drop every one of them.
  return payload?.enabled !== false;
}

export async function POST(req: Request) {
  if (!bearerOk(process.env.GENERIC_HOOK_TOKEN, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const type = typeof payload?.type === 'string' ? payload.type : 'unknown';
  try {
    const id = await insertEvent('generic', type, payload);

    // `jobs` is an array to match /api/hooks/github, which raises two jobs from one release. One
    // event yielding several jobs is the normal case now, so both webhooks answer the same shape.
    const jobs: string[] = [];
    if (isFeatureFlagLaunch(payload)) {
      const r = await q<{ id: string }>(
        `insert into jobs (kind, payload) values ('whatsnew', $1::jsonb) returning id`,
        [
          JSON.stringify({
            source: 'feature-flag',
            flag: text(payload.flag),
            name: text(payload.name),
            description: text(payload.description ?? payload.notes, MAX_DESCRIPTION),
            area: text(payload.area, 80),
            url: text(payload.url, 2000),
          }),
        ],
      );
      jobs.push(r.rows[0].id);
    }

    return json({ ok: true, id, jobs });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
