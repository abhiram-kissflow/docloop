import { pool, json } from '@/lib/db';
import { bearerOk, validateIngest } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type P = {
  label: string;
  description: string;
  ticket_count: number;
  questions: string[];
  suggestions: { type: string; body: string; article_external_id: string | null }[];
};

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

  // Whole-body validation (shape + PII guard) BEFORE any write.
  const v = validateIngest(body) as
    | { ok: true; value: { patterns: P[]; run: Record<string, unknown> | null } }
    | { ok: false; error: string };
  if (!v.ok) return json({ error: v.error }, 400);
  const patterns = v.value.patterns;
  const run = v.value.run;

  const client = await pool.connect().catch(() => null);
  if (!client) return json({ error: 'storage unavailable' }, 500);

  try {
    await client.query('begin');
    let suggestionCount = 0;

    for (const p of patterns) {
      const up = await client.query<{ id: string }>(
        `insert into patterns (label, description, question_count, ticket_count, last_seen)
         values ($1, $2, $3, $4, now())
         on conflict (label) do update set
           description    = excluded.description,
           question_count = excluded.question_count,
           ticket_count   = excluded.ticket_count,
           last_seen      = now()
         returning id`,
        [p.label, p.description, p.questions.length, p.ticket_count],
      );
      const patternId = up.rows[0].id;

      // History is kept: always insert a new questionnaire row, never delete old ones.
      await client.query(
        'insert into questionnaires (pattern_id, questions) values ($1, $2::jsonb)',
        [patternId, JSON.stringify(p.questions)],
      );

      for (const s of p.suggestions) {
        // Resolve the article by external_id, in the same transaction. An id the model invented
        // or mistyped resolves to null rather than failing: a bad link should cost one link, not
        // the whole batch. The subselect keeps it to a single round trip.
        await client.query(
          `insert into suggestions (type, pattern_id, article_id, body, status)
           values ($1, $2, (select id from articles where external_id = $3), $4, 'pending')`,
          [s.type, patternId, s.article_external_id, s.body],
        );
        suggestionCount++;
      }
    }

    // Run metadata lands in `events` — it already exists, it is exactly "something happened at a
    // time with a payload", and a mining run is an event. Cheaper than a column nothing else reads.
    if (run) {
      await client.query(
        `insert into events (source, type, payload) values ('intercom', 'mining_run', $1::jsonb)`,
        [JSON.stringify({ ...run, patterns: patterns.length, suggestions: suggestionCount })],
      );
    }

    await client.query('commit');
    return json({ ok: true, patterns: patterns.length, suggestions: suggestionCount });
  } catch {
    await client.query('rollback').catch(() => {});
    return json({ error: 'ingest failed' }, 500);
  } finally {
    client.release();
  }
}
