import { insertEvent, json } from '@/lib/db';
import { verifyGithubSignature } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

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
    return json({ ok: true, id });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
