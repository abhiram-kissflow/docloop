import { q, json } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ponytail: the jobs table IS the queue. Ceiling: one claim round-trip per poll,
// no visibility timeout — a worker that dies leaves a row stuck in 'running'.
// Upgrade path: a reaper that resets rows where updated_at < now() - interval.
// `kind` is filtered in the CLAIM itself, not by the caller after the fact. Without it this
// returns the oldest pending job of ANY kind, and a worker that claims someone else's job has
// already taken it — the row is `running` before anyone can tell it was the wrong one, and the
// only honest thing left to do is fail it. With one job kind that was harmless; with three
// (staleness, newdoc, whatsnew) it means a staleness poll can destroy a pending whatsnew job.
// Unattended under launchd, that is silent data loss on a timer.
// $2 null means "any kind", which keeps the old behaviour available for a generic poller.
const CLAIM = `update jobs set status='running', updated_at=now()
where id in (
  select id from jobs
  where status='pending' and ($2::text is null or kind = $2::text)
  order by id limit $1
  for update skip locked
)
returning id, kind, payload`;

export async function GET(req: Request) {
  if (!bearerOk(process.env.WORKER_API_KEY, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const url = new URL(req.url);
  const raw = Number(url.searchParams.get('limit') ?? 1);
  const limit = Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.trunc(raw))) : 1;
  // Bounded: a kind is a short identifier, and this reaches SQL as a parameter either way.
  const kindParam = url.searchParams.get('kind');
  const kind = kindParam && kindParam.length <= 40 ? kindParam : null;

  try {
    const r = await q<{ id: string; kind: string; payload: unknown }>(CLAIM, [limit, kind]);
    return json({ jobs: r.rows });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
