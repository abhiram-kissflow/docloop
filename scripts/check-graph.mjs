#!/usr/bin/env node
// Is the doc↔code mapping still describing the graph it was built from?
//
//   node --max-old-space-size=4096 scripts/check-graph.mjs
//   exit 0 = current, exit 1 = stale (regenerate)
//
// This exists because the first real graph refresh silently invalidated everything derived from
// it, and nothing noticed. Community ids are positions in a Louvain partition, not identifiers:
// the refresh renumbered the whole partition, so all 114 mapped ids still existed while 39 of 40
// sampled contained none of their original files. The mapping was not stale, it was WRONG, and it
// would have kept assigning code changes to the wrong articles indefinitely.
//
// A system whose whole purpose is noticing that documentation has drifted from code should not be
// unable to notice when its own index has drifted from the code.

import fs from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const GRAPH = `${process.env.HOME}/.graphify-data/kissflow-cross-repo/graphify-out/graph.json`;
const MAP = `${ROOT}/fixtures/code-areas.json`;

if (!fs.existsSync(GRAPH)) {
  console.error(`[check-graph] graph not found at ${GRAPH}`);
  process.exit(1);
}

const graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
const mapping = JSON.parse(fs.readFileSync(MAP, 'utf8'));

const communities = new Set();
for (const n of graph.nodes || []) if (n.community !== undefined && n.community !== null) communities.add(n.community);
const now = { nodes: (graph.nodes || []).length, links: (graph.links || []).length, communities: communities.size };
const then = mapping.graph;

if (!then) {
  console.error('[check-graph] STALE: fixtures/code-areas.json predates fingerprinting — regenerate.');
  process.exit(1);
}

const same = then.nodes === now.nodes && then.links === now.links && then.communities === now.communities;
console.log(`  built from: ${then.nodes} nodes, ${then.links} links, ${then.communities} communities`);
console.log(`  graph now:  ${now.nodes} nodes, ${now.links} links, ${now.communities} communities`);

if (same) {
  console.log('[check-graph] current — the mapping describes the graph on disk.');
  process.exit(0);
}

console.error(
  '\n[check-graph] STALE. The graph has been refreshed since this mapping was built, so every\n' +
    'community id in it may now point at different code. B1 will map changed files to the wrong\n' +
    'articles until this is regenerated:\n\n' +
    '  node --max-old-space-size=4096 scripts/map-areas.mjs --code\n' +
    '  node --max-old-space-size=4096 scripts/build-path-areas.mjs\n'
);
process.exit(1);
