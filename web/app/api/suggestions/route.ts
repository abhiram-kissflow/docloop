import { pool, json } from '@/lib/db';
import { bearerOk, validateSuggestions } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Standalone, article-linked suggestions (CONTRACT §3). B1 produces these: they come from a code
// change rather than a cluster of tickets, so there is no pattern, label or questionnaire to hang
// them on. /api/ingest/patterns is pattern-shaped and stays that way; bending it to accept two
// unrelated shapes would make both harder to reason about.
//
// Note this is /api/suggestions (worker, bearer) and NOT /api/suggestions/[id] (dashboard, cookie).
// Same prefix, deliberately different auth, because they serve different callers.

type S = { type: string; body: string; article_external_id: string | null; source: string };

export async function POST(req: Request) {
  if (!bearerOk(process.env.WORKER_API_KEY, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const v = validateSuggestions(body) as
    | { ok: true; value: { suggestions: S[] } }
    | { ok: false; error: string };
  if (!v.ok) return json({ error: v.error }, 400);

  const client = await pool.connect().catch(() => null);
  if (!client) return json({ error: 'storage unavailable' }, 500);

  try {
    await client.query('begin');
    let created = 0;
    let unresolved = 0;

    for (const s of v.value.suggestions) {
      // Same resolve-or-null as the ingest route: an external_id that does not match resolves to
      // NULL instead of failing, so one bad link costs one link rather than the whole batch.
      // `unresolved` is returned so a mapping that has gone stale is visible rather than silent —
      // a suggestion that quietly loses its article still looks fine on the dashboard.
      const r = await client.query<{ article_id: string | null }>(
        `insert into suggestions (type, pattern_id, article_id, body, status, source)
         values ($1, null, (select id from articles where external_id = $2), $3, 'pending', $4)
         returning article_id`,
        [s.type, s.article_external_id, s.body, s.source],
      );
      created++;
      if (s.article_external_id !== null && r.rows[0].article_id === null) unresolved++;
    }

    await client.query('commit');
    return json({ ok: true, created, unresolved });
  } catch {
    await client.query('rollback').catch(() => {});
    return json({ error: 'ingest failed' }, 500);
  } finally {
    client.release();
  }
}
