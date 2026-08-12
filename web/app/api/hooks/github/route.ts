import { insertEvent, json, q } from '@/lib/db';
import { verifyGithubSignature } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// A push is stored as an event AND enqueued as a staleness job (B1). The handler stays thin: it
// extracts the changed files and stops. Mapping files to areas, areas to articles and articles to
// suggestions is the worker's job, because it needs fixtures/path-areas.json and because a webhook
// that does real work times out under a monorepo-sized push.
const MAX_FILES = 500;

/**
 * Union of added + modified + removed across every commit in a push, deduped and capped.
 * Removed files matter as much as added ones: a deleted module is a strong staleness signal.
 */
function changedFiles(payload: any): { files: string[]; truncated: boolean } {
  const seen = new Set<string>();
  for (const c of Array.isArray(payload?.commits) ? payload.commits : []) {
    for (const key of ['added', 'modified', 'removed']) {
      for (const f of Array.isArray(c?.[key]) ? c[key] : []) {
        if (typeof f === 'string' && f) seen.add(f);
      }
    }
  }
  const all = [...seen];
  return { files: all.slice(0, MAX_FILES), truncated: all.length > MAX_FILES };
}

/** Only the default branch. A push to a feature branch documents nothing yet. */
function isDefaultBranchPush(payload: any): boolean {
  const ref = typeof payload?.ref === 'string' ? payload.ref : '';
  const def = typeof payload?.repository?.default_branch === 'string' ? payload.repository.default_branch : '';
  return Boolean(def) && ref === `refs/heads/${def}`;
}

export async function POST(req: Request) {
  // Signature is over the RAW bytes — read text() before any JSON.parse.
  const raw = await req.text();
  const ok = verifyGithubSignature(
    process.env.GITHUB_WEBHOOK_SECRET,
    raw,
    req.headers.get('x-hub-signature-256'),
  );
  if (!ok) return json({ error: 'bad signature' }, 401);

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const type = req.headers.get('x-github-event') || 'unknown';
  try {
    const id = await insertEvent('github', type, payload);

    // Enqueue B1 work only for a default-branch push that actually touched files. A tag push, a
    // branch delete or an empty push produces no job — an empty queue entry costs a worker cycle
    // and yields nothing.
    let job: string | null = null;
    if (type === 'push' && isDefaultBranchPush(payload)) {
      const { files, truncated } = changedFiles(payload as any);
      if (files.length) {
        const p = payload as any;
        const r = await q<{ id: string }>(
          `insert into jobs (kind, payload) values ('staleness', $1::jsonb) returning id`,
          [
            JSON.stringify({
              repo: p?.repository?.full_name ?? null,
              ref: p?.ref ?? null,
              after: p?.after ?? null,
              commits: Array.isArray(p?.commits) ? p.commits.length : 0,
              files,
              truncated,
            }),
          ],
        );
        job = r.rows[0].id;
      }
    }

    // Workstream C: a published release is the signal that something user-visible shipped.
    // `released` is deliberately excluded — GitHub fires both for the same release, and acting on
    // each would raise every documentation proposal twice.
    if (type === 'release' && (payload as any)?.action === 'published') {
      const p = payload as any;
      const r = await q<{ id: string }>(
        `insert into jobs (kind, payload) values ('newdoc', $1::jsonb) returning id`,
        [
          JSON.stringify({
            repo: p?.repository?.full_name ?? null,
            tag: p?.release?.tag_name ?? null,
            name: p?.release?.name ?? null,
            // Truncated here rather than in the worker: this is model-prompt input, and §6.6 says
            // bound it at the boundary where it arrives.
            body: typeof p?.release?.body === 'string' ? p.release.body.slice(0, 20000) : '',
            url: p?.release?.html_url ?? null,
          }),
        ],
      );
      job = r.rows[0].id;
    }

    return json({ ok: true, id, job });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
