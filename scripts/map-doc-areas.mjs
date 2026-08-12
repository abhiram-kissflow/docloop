// Applies fixtures/category-areas.json to the articles index.
//
//   node scripts/map-doc-areas.mjs | psql -d docloop
//
// Emits SQL rather than connecting, like seed-articles.mjs and import-docs.mjs (CONTRACT §5).
//
// This is the doc half of the doc↔code index. scripts/map-areas.mjs assigns areas to CODE from
// the graph; this assigns them to ARTICLES from the documentation platform's own category tree.
// Both sides land in the same 14-slug vocabulary from fixtures/taxonomy.json, which is the whole
// point — a changed file resolves to an area, and an area resolves to the articles that document
// it.
//
// Existing tags are MERGED, never replaced. The API articles carry OpenAPI tags that predate any
// of this, and an import that discards them would quietly shrink the index it claims to build.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

const taxonomy = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures', 'taxonomy.json'), 'utf8'));
const known = new Set(taxonomy.areas.map((a) => a.slug));

const map = JSON.parse(fs.readFileSync(path.join(REPO, 'fixtures', 'category-areas.json'), 'utf8'));

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";

// A slug that is not in the taxonomy is a typo, not a new area. Fail loudly: a silent bad tag
// is invisible until someone wonders why an area returns nothing.
const bad = [];
for (const [category, areas] of Object.entries(map.categories)) {
  for (const a of areas) if (!known.has(a)) bad.push(`${category} -> ${a}`);
}
if (bad.length) {
  console.error(`area slugs not in fixtures/taxonomy.json:\n  ${bad.join('\n  ')}`);
  process.exit(1);
}

console.log('begin;');
let statements = 0;
for (const [category, areas] of Object.entries(map.categories)) {
  const tags = areas.map((a) => `area:${a}`);
  // Merge and de-duplicate in SQL so re-running is idempotent: the union of what is already
  // there with what this map says, never a replacement.
  console.log(
    `update articles set features = (
  select coalesce(jsonb_agg(distinct e), '[]'::jsonb)
  from (
    select jsonb_array_elements_text(features) as e
    union
    select unnest(array[${tags.map(q).join(', ')}])
  ) merged
) where category = ${q(category)};`
  );
  statements++;
}
console.log('commit;');

const unmapped = Object.keys(map.unmapped ?? {}).length;
console.error(
  `[map-doc-areas] ${statements} category path(s) tagged; ${unmapped} left deliberately untagged ` +
    `(see the "unmapped" block in fixtures/category-areas.json for why each one)`
);
