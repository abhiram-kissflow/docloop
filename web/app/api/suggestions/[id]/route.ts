import { q, json } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// ponytail: no auth — same-origin dashboard use only (CONTRACT §3), and the whole
// app is behind a private Vercel preview for now. Ceiling: anyone who reaches the
// URL can approve/dismiss. Upgrade path: Vercel Access / a shared cookie.
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const suggestionId = Number(id);
  if (!Number.isInteger(suggestionId) || suggestionId <= 0) {
    return json({ error: 'bad id' }, 400);
  }

  let body: { status?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }
  if (body?.status !== 'approved' && body?.status !== 'dismissed') {
    return json({ error: 'status must be approved|dismissed' }, 400);
  }

  try {
    const r = await q('update suggestions set status=$2 where id=$1 returning id', [
      suggestionId,
      body.status,
    ]);
    if (r.rowCount === 0) return json({ error: 'no such suggestion' }, 404);
    return json({ ok: true });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
