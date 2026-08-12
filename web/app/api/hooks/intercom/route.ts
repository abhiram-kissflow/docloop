import { insertEvent, json } from '@/lib/db';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// TODO(signature): Intercom webhook signature verification (X-Hub-Signature, sha1
// HMAC over the raw body with the developer-app client secret) is NOT implemented.
// It needs an Intercom developer app to exist first — PLAN §8 open question.
// Until then this endpoint stores and acknowledges only. Do not point anything
// security-sensitive at it, and keep the URL unadvertised.
export async function POST(req: Request) {
  const raw = await req.text();
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw);
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const type = typeof payload?.topic === 'string' ? payload.topic : 'unknown';
  try {
    const id = await insertEvent('intercom', type, payload);
    return json({ ok: true, id }, 202);
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
