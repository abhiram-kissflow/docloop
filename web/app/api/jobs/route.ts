import { q, json } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ponytail: the jobs table IS the queue. Ceiling: one claim round-trip per poll,
// no visibility timeout — a worker that dies leaves a row stuck in 'running'.
// Upgrade path: a reaper that resets rows where updated_at < now() - interval.
const CLAIM = `update jobs set status='running', updated_at=now()
where id in (
  select id from jobs where status='pending' order by id limit $1
  for update skip locked
)
returning id, kind, payload`;

export async function GET(req: Request) {
  if (!bearerOk(process.env.WORKER_API_KEY, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  const raw = Number(new URL(req.url).searchParams.get('limit') ?? 1);
  const limit = Number.isFinite(raw) ? Math.min(10, Math.max(1, Math.trunc(raw))) : 1;

  try {
    const r = await q<{ id: string; kind: string; payload: unknown }>(CLAIM, [limit]);
    return json({ jobs: r.rows });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
