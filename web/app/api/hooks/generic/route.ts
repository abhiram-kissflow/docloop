import { insertEvent, json } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    return json({ ok: true, id });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
