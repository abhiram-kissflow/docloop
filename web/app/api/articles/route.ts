import { q, json } from '@/lib/db';
import { bearerOk } from '@/lib/pure.mjs';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// The doc↔code index, handed to the worker so its suggestions are grounded in the articles that
// actually exist (CONTRACT §3). Without it the miner cannot tell "no doc covers this" from "I was
// not shown the docs" — on the first real run every `create` suggestion turned out to describe
// something already published.
//
// `url` is not returned: the worker needs identity for matching, not links, and everything here
// is fed into a model prompt. Send the minimum that does the job.
//
// ponytail: 2000-row cap, no pagination. Ceiling: an index larger than that is silently truncated
// — which is why the count is returned, so the caller can notice. Upgrade path: keyset pagination
// on (platform, title) if the doc set ever outgrows one prompt, at which point prompt size is the
// real constraint anyway.
const LIMIT = 2000;

const SELECT = `select external_id, title, platform, features
                from articles
                order by platform, title
                limit ${LIMIT}`;

export async function GET(req: Request) {
  if (!bearerOk(process.env.WORKER_API_KEY, req.headers.get('authorization'))) {
    return json({ error: 'unauthorized' }, 401);
  }

  try {
    const r = await q<{
      external_id: string;
      title: string;
      platform: string;
      features: unknown;
    }>(SELECT);
    return json({ articles: r.rows, count: r.rows.length, truncated: r.rows.length === LIMIT });
  } catch {
    return json({ error: 'storage failed' }, 500);
  }
}
