// Seeds the articles table — the doc↔code index BLUEPRINT §3 calls the keystone.
//
// Emits SQL on stdout; apply with:  node scripts/seed-articles.mjs | psql -d docloop
//
// It writes SQL rather than connecting, because CONTRACT §5 says the worker never touches the
// database directly and this runs beside it. It is also a one-time seed, not part of the runtime
// loop, so it does not earn an API route.
//
// ponytail: titles for the two HTML sources are derived from URL slugs rather than fetched.
// Ceiling: a slug that misrepresents its page gets a wrong title. Upgrade path: scrape titles
// once the index proves useful enough to be worth ~80 page fetches.

import fs from 'node:fs';

const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
const rows = [];

/** A URL slug into something a human reads: "form/table/addrows" -> "Form › Table › Add rows" */
function titleFromPath(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (!parts.length) return 'Home';
  return parts
    .map((p) =>
      p
        .replace(/[-_]+/g, ' ')
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .replace(/^\w/, (c) => c.toUpperCase())
    )
    .join(' › ');
}

function addUrlFile(file, platform) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const url = line.trim();
    if (!url.startsWith('http')) continue;
    let u;
    try {
      u = new URL(url);
    } catch {
      continue;
    }
    // Community topic URLs are /t/<id>/<slug>; the id carries no meaning for a reader.
    const parts = u.pathname.split('/').filter(Boolean);
    const readable = parts[0] === 't' && parts.length >= 3 ? parts.slice(2).join('/') : u.pathname;
    rows.push({
      external_id: url,
      title: titleFromPath(readable) || u.hostname,
      url,
      platform,
      features: [],
    });
  }
}

addUrlFile('/tmp/map-developers.kissflow.com.txt', 'developers');
addUrlFile('/tmp/map-community.kissflow.com.txt', 'community');

// The API reference is an OpenAPI document, so every operation is a real, enumerable article —
// and its tags are the first genuine feature mapping in the index rather than a guess.
//
// PROVENANCE, stated because the two halves come from different places:
//   STRUCTURE comes from the OpenAPI spec (`info.title` is "Kissflow API documentation"). It is
//   served from zingworks.com; no Kissflow domain hosts it — api/kissflow/community/developers
//   were all probed and 404.
//   THE READER-FACING URL is api.kissflow.com, which is the canonical published reference.
// api.kissflow.com is a Postman Documenter page: one HTML shell, operations behind lazily-loaded
// `#<uuid>` anchors, and Postman's collection API 404s. It cannot be enumerated, so crawling it
// would yield ONE article for the whole API instead of 105. Hence: spec for structure,
// api.kissflow.com for the link. Operation identity lives in external_id and title, so a writer
// can still find the exact endpoint on the page.
// Upgrade path: if the per-operation anchors ever become fetchable, only `url` changes here.
if (fs.existsSync('/tmp/kf-openapi.json')) {
  const spec = JSON.parse(fs.readFileSync('/tmp/kf-openapi.json', 'utf8'));
  const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
  for (const [path, item] of Object.entries(spec.paths || {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const verb = method.toUpperCase();
      rows.push({
        external_id: `api:${verb} ${path}`,
        title: op.summary ? `${op.summary} (${verb} ${path})` : `${verb} ${path}`,
        url: 'https://api.kissflow.com/',
        platform: 'api',
        features: op.tags || [],
      });
    }
  }
}

console.log('begin;');
for (const r of rows) {
  console.log(
    `insert into articles (external_id, title, url, platform, features) values (` +
      `${q(r.external_id)}, ${q(r.title.slice(0, 300))}, ${q(r.url)}, ${q(r.platform)}, ` +
      `${q(JSON.stringify(r.features))}::jsonb) ` +
      `on conflict (external_id) do update set title = excluded.title, url = excluded.url, ` +
      `platform = excluded.platform, features = excluded.features;`
  );
}
console.log('commit;');
console.error(`[seed] ${rows.length} articles`);
