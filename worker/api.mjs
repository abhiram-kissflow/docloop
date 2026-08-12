// The worker's one way of talking to the Docloop API.
//
// Extracted the moment a second worker needed it. It is small enough to have copied, but it
// carries the bearer token, and an auth helper that exists twice is an auth helper that drifts —
// which is the same argument CONTRACT §6.1 makes about the shared rule block, one level down.
//
// Errors surface the route and status but never the response body beyond its `error` field: a
// 500 from Postgres can carry a query fragment, and §6.4 says nothing unvetted reaches a log.

/**
 * @param {string} pathname  e.g. '/api/jobs?limit=1'
 * @param {{apiUrl: string, apiKey: string}} auth
 * @param {RequestInit} [init]
 */
export async function api(pathname, { apiUrl, apiKey }, init = {}) {
  const res = await fetch(`${apiUrl}${pathname}`, {
    ...init,
    headers: {
      authorization: `Bearer ${apiKey}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = { error: `non-JSON response (${text.length} chars)` };
  }
  if (!res.ok) throw new Error(`${pathname} -> HTTP ${res.status}: ${body.error || 'unknown'}`);
  return body;
}

/** Reads and validates the two env vars every worker needs. Fails loudly, never silently. */
export function requireEnv() {
  const apiUrl = (process.env.DOCLOOP_API_URL || '').replace(/\/+$/, '');
  const apiKey = process.env.WORKER_API_KEY || '';
  if (!apiUrl || !apiKey) {
    throw new Error('missing env: DOCLOOP_API_URL and WORKER_API_KEY are both required (see README)');
  }
  return { apiUrl, apiKey };
}

/**
 * Claim one job and confirm it is the kind this worker handles. A job of the wrong kind is handed
 * back as failed rather than dropped: a row stuck in `running` forever is worse than a visible
 * failure, and nothing else reaps them.
 * @returns {Promise<any|null>} the job, or null when there is nothing to do
 */
export async function claimJob(kind, auth) {
  // Ask for OUR kind. Claiming by kind is the fix for a real defect: /api/jobs used to return the
  // oldest pending job of any kind, so a staleness poll could claim a whatsnew job — and by the
  // time the mismatch was noticed the row was already `running`, leaving nothing to do but fail
  // work that belonged to another worker. The mismatch branch below is now a belt-and-braces
  // guard against an older server, not the normal path.
  const { jobs } = await api(`/api/jobs?limit=1&kind=${encodeURIComponent(kind)}`, auth);
  const job = jobs?.[0];
  if (!job) return null;
  if (job.kind !== kind) {
    await api('/api/results', auth, {
      method: 'POST',
      body: JSON.stringify({
        job_id: Number(job.id),
        status: 'failed',
        result: { error: `not a ${kind} job: ${job.kind}` },
      }),
    });
    console.error(`[worker] claimed a ${job.kind} job by mistake — returned it as failed`);
    return null;
  }
  return job;
}

/**
 * Claim a job, run the work, and ALWAYS report the outcome — including a throw.
 *
 * Found by the session building whatsnew, running it rather than reading it: claimJob() sets the
 * row to `running`, and nothing in this system reaps a stuck row. So any throw after the claim —
 * an unparseable draft, a dead API, a missing binary — left the job claimed forever and invisible.
 * Every later run walked straight past it. staleness.mjs and newdoc.mjs both had that shape.
 *
 * The failure is reported BEFORE the error is re-thrown, so the operator sees it in the job row
 * and not only in a log nobody is tailing. Reporting is itself best-effort: if the API is what
 * broke, there is nowhere to report to, and losing the original error to a second failure would
 * be worse than a stuck row.
 *
 * §6.4: the recorded reason is our own error message, bounded. Model output never reaches an
 * error message by construction — extractJson reports lengths, not content.
 *
 * @param {string} kind
 * @param {{apiUrl: string, apiKey: string}} auth
 * @param {(job: any) => Promise<any>} fn
 * @returns {Promise<any|null>} fn's result, or null when there was no job to claim
 */
export async function withJob(kind, auth, fn) {
  const job = await claimJob(kind, auth);
  if (!job) return null;
  try {
    return await fn(job);
  } catch (err) {
    await api('/api/results', auth, {
      method: 'POST',
      body: JSON.stringify({
        job_id: Number(job.id),
        status: 'failed',
        result: { error: String(err?.message ?? err).slice(0, 500) },
      }),
    }).catch(() => {
      console.error(`[worker] job ${job.id} failed AND could not be reported — it stays 'running'`);
    });
    throw err;
  }
}
