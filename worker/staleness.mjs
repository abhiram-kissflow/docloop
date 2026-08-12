#!/usr/bin/env node
// Docloop worker — Workstream B1 (codebase staleness).
//
// A push lands, /api/hooks/github enqueues a `staleness` job holding the changed files, and this
// claims it and answers one question: which published articles might that change have invalidated?
//
//   node staleness.mjs [--dry-run] [--max=10]
//
// WHAT THIS DELIBERATELY DOES NOT DO: it does not claim an article IS stale. It says a change
// touched code in an area the article documents, and a human should look. Asserting staleness
// needs the article text and the diff read together, which is the expensive next step (BLUEPRINT
// §5, B1). Overclaiming is how a review queue earns the reputation that gets it ignored, and
// BLUEPRINT §10.0 is explicit that an area mapping is a hint and never proof.
//
// ponytail: one job per invocation, no batching across pushes, no dedupe against suggestions
// already pending for the same article. Ceiling: ten pushes in an hour produce ten near-identical
// suggestions. Upgrade path: collapse by article_id over a time window once real push volume shows
// whether that is actually a problem.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { api, requireEnv, claimJob } from './api.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PATH_AREAS = path.join(HERE, '..', 'fixtures', 'path-areas.json');

export function parseFlags(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      max: { type: 'string', default: '10' },
      help: { type: 'boolean', default: false },
    },
  });
  const n = Number.parseInt(String(values.max), 10);
  return { dryRun: values['dry-run'], max: Number.isFinite(n) && n > 0 ? n : 10, help: values.help };
}

const USAGE = `docloop staleness worker — turn a push into "these articles may be affected".

  node staleness.mjs [--dry-run] [--max=10]

  --dry-run   claim nothing, POST nothing; print what the last-seen job would produce
  --max=N     most suggestions to raise per push (default 10)

Env: DOCLOOP_API_URL, WORKER_API_KEY
`;

// ---------------------------------------------------------------- pure logic (testable)

/**
 * Longest-prefix match of a changed file against the directory→area map.
 * Longest wins because a specific directory knows better than its parent.
 * @returns {string[]} area slugs, empty when nothing matches
 */
export function areasForFile(file, prefixes) {
  if (typeof file !== 'string' || !file) return [];
  let best = null;
  let bestLen = -1;
  for (const prefix of Object.keys(prefixes)) {
    // Guard the boundary: `src/form` must not match `src/formatting/x.ts`.
    if (file === prefix || file.startsWith(prefix + '/')) {
      if (prefix.length > bestLen) {
        bestLen = prefix.length;
        best = prefixes[prefix];
      }
    }
  }
  return best ? [best.area] : [];
}

/**
 * Changed files → area slugs ranked by how many files hit each. The count is the whole signal:
 * a push touching thirty files in forms-fields is a far stronger hint than one touching a single
 * file there.
 * @returns {{area: string, files: string[]}[]} most-touched first
 */
export function rankAreas(files, prefixes) {
  const byArea = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    for (const area of areasForFile(f, prefixes)) {
      if (!byArea.has(area)) byArea.set(area, []);
      byArea.get(area).push(f);
    }
  }
  return [...byArea.entries()]
    .map(([area, hits]) => ({ area, files: hits }))
    .sort((a, b) => b.files.length - a.files.length || a.area.localeCompare(b.area));
}

/**
 * Articles to raise, most-affected area first, capped. Within an area the order is stable so
 * repeated pushes to the same area surface the same articles rather than a random subset.
 */
export function pickArticles(ranked, articles, max) {
  const out = [];
  const seen = new Set();
  for (const { area, files } of ranked) {
    const tag = `area:${area}`;
    const matching = articles
      .filter((a) => Array.isArray(a.features) && a.features.includes(tag))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
    for (const a of matching) {
      if (out.length >= max) return out;
      if (seen.has(a.external_id)) continue;
      seen.add(a.external_id);
      out.push({ article: a, area, files });
    }
  }
  return out;
}

/**
 * The suggestion body. Full repo-relative paths ONLY — a bare multi-dot filename reads as a
 * hostname to the §6.1 guard and would drop the whole suggestion (see commit 9b2f9df).
 * The wording is deliberately "may need", never "is stale": see the header.
 */
export function buildBody({ area, files, repo, commits }, sampleLimit = 8) {
  const shown = files.slice(0, sampleLimit);
  const more = files.length - shown.length;
  return [
    `A push to \`${repo || 'the product repo'}\` changed ${files.length} file${files.length === 1 ? '' : 's'}`,
    `in the **${area}** area across ${commits} commit${commits === 1 ? '' : 's'}.`,
    '',
    'This article documents that area, so it **may need** review. Nothing here checks the',
    'article text against the change — that is a human judgement, and this is only a pointer.',
    '',
    'Changed files:',
    ...shown.map((f) => `- \`${f}\``),
    ...(more > 0 ? [`- …and ${more} more`] : []),
  ].join('\n');
}

// ---------------------------------------------------------------- io

async function main() {
  const flags = parseFlags();
  if (flags.help) {
    console.log(USAGE);
    return;
  }

  const auth = requireEnv();

  const prefixes = JSON.parse(fs.readFileSync(PATH_AREAS, 'utf8')).prefixes;

  const job = await claimJob('staleness', auth);
  if (!job) {
    console.error('[staleness] no pending staleness job');
    return;
  }

  const { files = [], repo = null, commits = 0, truncated = false } = job.payload || {};
  const ranked = rankAreas(files, prefixes);
  const unmapped = files.filter((f) => areasForFile(f, prefixes).length === 0).length;
  console.error(
    `[staleness] job ${job.id}: ${files.length} files${truncated ? ' (TRUNCATED at the webhook cap)' : ''}, ` +
      `${ranked.length} area(s), ${unmapped} file(s) mapped to no area`
  );

  const { articles = [] } = await api('/api/articles', auth);
  const picks = pickArticles(ranked, articles, flags.max);

  const suggestions = picks.map(({ article, area, files: hits }) => ({
    type: 'update',
    article_external_id: article.external_id,
    source: 'staleness',
    body: buildBody({ area, files: hits, repo, commits }),
  }));

  if (flags.dryRun) {
    console.log(JSON.stringify({ job: job.id, areas: ranked.map((r) => `${r.area}:${r.files.length}`), suggestions }, null, 2));
    console.error('[staleness] --dry-run: nothing was POSTed and the job stays claimed');
    return;
  }

  let created = 0;
  let unresolved = 0;
  if (suggestions.length) {
    const r = await api('/api/suggestions', auth, { method: 'POST', body: JSON.stringify({ suggestions }) });
    created = r.created;
    unresolved = r.unresolved;
  }
  console.error(`[staleness] raised ${created} suggestion(s)${unresolved ? `, ${unresolved} with an unresolved article link` : ''}`);

  await api('/api/results', auth, {
    method: 'POST',
    body: JSON.stringify({
      job_id: Number(job.id),
      status: 'done',
      result: { files: files.length, unmapped, areas: ranked.map((r) => ({ area: r.area, files: r.files.length })), created, unresolved },
    }),
  });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[staleness] failed: ${err.message}`);
    process.exit(1);
  });
}
