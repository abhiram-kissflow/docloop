// Assigns both halves of the doc↔code index into the closed taxonomy (fixtures/taxonomy.json),
// which is what BLUEPRINT §10.0 says is needed before B1 (codebase staleness) can be built.
//
//   node scripts/map-areas.mjs --articles     assign every article  -> area slugs
//   node scripts/map-areas.mjs --code         assign graph communities -> area slugs
//   node scripts/map-areas.mjs --articles --apply | psql -d docloop
//
// WHY A MODEL AND NOT A REGEX: the previous attempt matched article titles against code
// identifiers by term overlap and produced noise, because docs speak the user's language and code
// speaks the implementer's. Crossing that gap is a semantic job. The taxonomy keeps it honest —
// the model may only choose from a fixed list it cannot extend, so a wrong answer is a wrong
// CHOICE, reviewable at a glance, rather than an invented label nobody can check.
//
// Code-side output is written to fixtures/code-areas.json rather than a table, on purpose: it is
// derived from a static graph, it should be regenerated when the graph is refreshed, and a writer
// should be able to review it in a diff. A table would hide it.
//
// ponytail: one model call per side, no batching, no retry. Ceiling: if the taxonomy or the corpus
// grows past a single prompt this needs chunking. Upgrade path: chunk by platform.

import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PSQL = '/opt/homebrew/opt/postgresql@17/bin/psql';
const GRAPH = `${process.env.HOME}/.graphify-data/kissflow-cross-repo/graphify-out/graph.json`;
const CLAUDE = process.env.CLAUDE_BIN || `${process.env.HOME}/.local/bin/claude`;

const argv = new Set(process.argv.slice(2));
const taxonomy = JSON.parse(fs.readFileSync(`${ROOT}/fixtures/taxonomy.json`, 'utf8'));
const SLUGS = new Set(taxonomy.areas.map((a) => a.slug));
const areaList = taxonomy.areas.map((a) => `  ${a.slug} — ${a.name}: ${a.hint}`).join('\n');

function ask(prompt) {
  // 20-minute ceiling: these prompts are small but the corpus is not.
  const out = execFileSync(CLAUDE, ['-p', prompt], {
    encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 20 * 60 * 1000,
  });
  const fence = out.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = fence ? fence[1] : out;
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first === -1 || last === -1) throw new Error(`no JSON in model output (${out.length} chars)`);
  return JSON.parse(text.slice(first, last + 1));
}

/** Enough of the graph's shape to notice it has been replaced. Cheap, and no hashing of 66 MB. */
export function graphFingerprint(graph) {
  const nodes = graph.nodes || [];
  const communities = new Set();
  for (const n of nodes) if (n.community !== undefined && n.community !== null) communities.add(n.community);
  return { nodes: nodes.length, links: (graph.links || []).length, communities: communities.size };
}

/** Drop anything the model invented. The taxonomy is closed; that is the point of it. */
const keepKnown = (arr) =>
  (Array.isArray(arr) ? arr : []).filter((s) => typeof s === 'string' && SLUGS.has(s)).slice(0, 2);

if (argv.has('--articles')) {
  const rows = execFileSync(PSQL, ['-d', 'docloop', '-At', '-F', '\t', '-c',
    "select id, platform, title from articles order by id"], { encoding: 'utf8' })
    .split('\n').filter(Boolean).map((l) => { const [id, platform, title] = l.split('\t'); return { id, platform, title }; });

  const listing = rows.map((r) => `${r.id}\t[${r.platform}] ${r.title}`).join('\n');
  const result = ask(
`You are indexing Kissflow's documentation. Assign each article to 1-2 product areas.

AREAS — you may ONLY use these slugs, exactly as written. Never invent one:
${areaList}

ARTICLES (id, platform, title):
${listing}

Judge by what the article is ABOUT for a reader. An API operation about portal users is portals,
not api-platform; api-platform is for docs about the API itself — auth, keys, versioning, limits.
If an article genuinely fits nothing, give it an empty array rather than forcing a match.

Return STRICT JSON only, no prose, no fences:
{"assignments": {"<article id>": ["slug"], "<article id>": ["slug","slug"]}}`);

  const assignments = result.assignments || {};
  let n = 0;
  const sql = [];
  for (const r of rows) {
    const areas = keepKnown(assignments[r.id]);
    if (!areas.length) continue;
    const existing = execFileSync(PSQL, ['-d', 'docloop', '-At', '-c',
      `select coalesce(features,'[]'::jsonb)::text from articles where id=${Number(r.id)}`], { encoding: 'utf8' }).trim();
    let keep = [];
    try { keep = JSON.parse(existing).filter((x) => typeof x === 'string' && !x.startsWith('area:')); } catch { /* default [] */ }
    const merged = [...new Set([...keep, ...areas.map((a) => `area:${a}`)])];
    sql.push(`update articles set features = '${JSON.stringify(merged).replace(/'/g, "''")}'::jsonb where id = ${Number(r.id)};`);
    n++;
  }
  if (argv.has('--apply')) console.log(['begin;', ...sql, 'commit;'].join('\n'));
  else console.log(sql.slice(0, 5).join('\n') + `\n-- …${sql.length} statements. Re-run with --apply to emit all.`);
  console.error(`[areas] ${n} of ${rows.length} articles assigned`);
}

if (argv.has('--code')) {
  const graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
  const byCommunity = new Map();
  for (const node of graph.nodes || []) {
    if (node.community === undefined || node.community === null) continue;
    if (!byCommunity.has(node.community)) byCommunity.set(node.community, { size: 0, paths: [] });
    const c = byCommunity.get(node.community);
    c.size++;
    if (node.source_file && c.paths.length < 14) c.paths.push(node.source_file);
  }
  // Only communities big enough to be a feature rather than an accident.
  const big = [...byCommunity.entries()].filter(([, c]) => c.size >= 25).sort((a, b) => b[1].size - a[1].size).slice(0, 120);

  const listing = big.map(([id, c]) => `${id} (${c.size} nodes)\n${c.paths.map((p) => '    ' + p).join('\n')}`).join('\n\n');
  const result = ask(
`You are mapping a Kissflow codebase onto its product areas. Each block below is one cluster of
related source files. Decide which product area each cluster implements.

AREAS — you may ONLY use these slugs, exactly as written. Never invent one:
${areaList}

CLUSTERS (community id, size, sample file paths):
${listing}

Judge by what the code DOES for a user, from the paths. Infrastructure with no user-facing area
(build tooling, test helpers, generic utilities) should get an empty array — that is a useful
answer, not a failure.

Return STRICT JSON only, no prose, no fences:
{"assignments": {"<community id>": ["slug"], "<community id>": []}}`);

  const assignments = result.assignments || {};
  const out = {};
  let n = 0;
  for (const [id, c] of big) {
    const areas = keepKnown(assignments[String(id)]);
    if (!areas.length) continue;
    out[id] = { areas, size: c.size, sample: c.paths.slice(0, 3) };
    n++;
  }
  const path = `${ROOT}/fixtures/code-areas.json`;
  fs.writeFileSync(path, JSON.stringify({
    _about: [
      'Graph community -> product area. Generated by scripts/map-areas.mjs --code; review in a diff.',
      'REGENERATE AFTER EVERY GRAPH REFRESH. Community ids are positions in a Louvain partition,',
      'not stable identifiers: a refresh renumbers everything, so the ids survive while their',
      'MEANING does not. Observed on the first real refresh — all 114 ids still existed and 39 of',
      '40 sampled contained none of their original files. Nothing detects that by id alone, which',
      'is what `graph` below is for.',
    ],
    // Fingerprint of the graph this was derived from. A mismatch means this file describes code
    // that no longer exists in that arrangement — see scripts/check-graph.mjs.
    graph: graphFingerprint(graph),
    communities: out,
  }, null, 2) + '\n');
  console.error(`[areas] ${n} of ${big.length} communities mapped -> ${path}`);
}

if (!argv.has('--articles') && !argv.has('--code')) {
  console.error('usage: map-areas.mjs [--articles [--apply]] [--code]');
  process.exit(2);
}
