import { q, json } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  if (!bearerOk(process.env.WORKER_API_KEY, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  let body: { job_id?: unknown; status?: unknown; result?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const jobId = Number(body?.job_id);
  if (!Number.isInteger(jobId) || jobId <= 0) return json({ error: 'job_id must be an integer' }, 400);
  if (body?.status !== 'done' && body?.status !== 'failed') {
    return json({ error: 'status must be done|failed' }, 400);
  }

  try {
    const r = await q<{ id: string }>(
      `update jobs set status=$2, result=$3::jsonb, updated_at=now() where id=$1 returning id`,
      [jobId, body.status, JSON.stringify(body.result ?? {})],
    );
    if (r.rowCount === 0) return json({ error: 'no such job' }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
