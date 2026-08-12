// Imports the real product documentation into the articles index — the first time this system
// has held a word of what an article actually SAYS.
//
//   node scripts/import-docs.mjs --file=export.csv | psql -d docloop
//
// Emits SQL on stdout rather than connecting, matching seed-articles.mjs and for the same reason
// (CONTRACT §5): nothing beside the worker touches the database directly.
//
// The input is an export from the documentation platform — community.kissflow.com, the
// documentation-section category — with title, text, postedOn, updatedOn, url, baseUri and
// category.path. That export answers a question BLUEPRINT §11 had left open since the beginning:
// which platform hosts the docs.
//
// WHY THE BODY IS NOT SCRUBBED: §6.1 governs ticket-derived text, which is attacker-influenced,
// customer-bearing and never published. An article is the opposite — written by the documentation
// team, reviewed, and already public. Scrubbing it deletes documentation rather than protecting
// anyone: 42 of 646 articles trip the guard and every hit is the docs' own example content. The
// scrub still applies to everything downstream that a model or a ticket touches.
//
// ponytail: a ~40-line CSV reader instead of a dependency. Ceiling: RFC 4180 only — quoted
// fields, doubled quotes, embedded newlines and CRLF. No delimiter sniffing, no BOM-less
// heuristics beyond stripping one. Upgrade path: a real parser the day an export defeats it,
// which this one does not.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

// Everything below the pure functions runs ONLY when this file is the entry point, so
// parseCsv() and htmlToText() can be imported and tested. A script that emits SQL on import
// cannot be verified, and a CSV reader nobody tests is a CSV reader that eats a field.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

const { values } = isMain
  ? parseArgs({
      options: {
        file: { type: 'string' },
        limit: { type: 'string' },
        help: { type: 'boolean', default: false },
      },
    })
  : { values: {} };

if (isMain && (values.help || !values.file)) {
  console.error(`Import documentation topics into the articles index.

  node scripts/import-docs.mjs --file=<export.csv> [--limit=N] | psql -d docloop

  --file=PATH   CSV export with title, text, url, baseUri, category.path, updatedOn
  --limit=N     import only the first N rows (for a dry look before committing to it)
`);
  process.exit(values.help ? 0 : 1);
}

// ---------------------------------------------------------------- CSV (RFC 4180)

/** @returns {string[][]} rows of raw cells */
export function parseCsv(input) {
  const text = input.replace(/^﻿/, '').replace(/\r\n/g, '\n');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        // A doubled quote is a literal quote; a lone one closes the field.
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  // A file not ending in a newline still has a last row.
  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

// ---------------------------------------------------------------- HTML → text

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’',
  lsquo: '‘', ldquo: '“', rdquo: '”', mdash: '—', ndash: '–',
  hellip: '…', check: '✓',
};

/**
 * Article HTML into plain text a model and a human can both read.
 *
 * Block boundaries become newlines rather than spaces: a list of field types collapsed onto one
 * line reads as prose and a reader loses the structure that made it a list. List items keep a
 * bullet for the same reason.
 */
export function htmlToText(html) {
  // A newline in HTML SOURCE is insignificant whitespace, not a line break — but a newline inside
  // <pre> is the whole point of <pre>, and this corpus is full of JavaScript samples. So the
  // pre blocks are protected, source whitespace collapses everywhere else, and only then are
  // block boundaries turned into real newlines. Without this a code sample arrives as one line.
  const KEEP = '\u0000'; // never present in the export; survives the collapse below
  return String(html ?? '')
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<pre[\s\S]*?<\/pre>/gi, (block) => block.replace(/\n/g, KEEP))
    .replace(/\s+/g, ' ')
    .replaceAll(KEEP, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    // NOT </li>: the opening <li> already began the line, and closing it too put a blank line
    // between every bullet, turning a tight list into a double-spaced one.
    .replace(/<\/(p|div|h[1-6]|tr|blockquote)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&([a-zA-Z]+);/g, (m, name) => ENTITIES[name] ?? m)
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------- SQL

const q = (s) => (s === null || s === undefined || s === '' ? 'null' : "'" + String(s).replace(/'/g, "''") + "'");

/** postgres wants ISO-ish; the export is 'YYYY-MM-DD HH:MM:SS' and sometimes empty. */
const ts = (s) => (/^\d{4}-\d{2}-\d{2}/.test(String(s ?? '')) ? q(s) : 'null');

if (!isMain) {
  // Imported for its pure functions; emit nothing.
} else {
const rows = parseCsv(fs.readFileSync(values.file, 'utf8'));
const header = rows.shift().map((h) => h.replace(/^﻿/, '').trim());
const col = (name) => header.indexOf(name);
const iTitle = col('title');
const iText = col('text');
const iUrl = col('url');
const iBase = col('baseUri');
const iCat = col('category.path');
const iUpdated = col('updatedOn');

for (const [name, i] of [['title', iTitle], ['text', iText], ['url', iUrl]]) {
  if (i === -1) {
    console.error(`export is missing the "${name}" column; got: ${header.join(', ')}`);
    process.exit(1);
  }
}

const limit = Number.parseInt(String(values.limit ?? ''), 10);
const wanted = Number.isFinite(limit) && limit > 0 ? rows.slice(0, limit) : rows;

let emitted = 0;
let skippedEmpty = 0;
const seen = new Set();

console.log('begin;');
for (const r of wanted) {
  const url = (r[iUrl] ?? '').trim();
  const base = (r[iBase] ?? '').trim().replace(/\/+$/, '');
  if (!url) continue;

  // external_id is the ABSOLUTE url. The export's url column is a path, and a path is only
  // unique within one platform — the index already holds api. and developers. articles.
  const externalId = /^https?:\/\//.test(url) ? url : `${base}${url}`;
  if (seen.has(externalId)) continue; // a topic listed under two categories exports twice
  seen.add(externalId);

  const body = htmlToText(r[iText]);
  if (!body) skippedEmpty++;

  // Upsert by external_id: re-importing a fresh export updates in place rather than duplicating,
  // and `features` is left ALONE — area tags are assigned by scripts/map-areas.mjs and an import
  // must not silently discard that work.
  console.log(
    `insert into articles (external_id, title, url, platform, category, body, doc_updated_at, imported_at)
values (${q(externalId)}, ${q((r[iTitle] ?? '').trim() || externalId)}, ${q(externalId)}, 'docs', ${q((r[iCat] ?? '').trim())}, ${q(body)}, ${ts(r[iUpdated])}, now())
on conflict (external_id) do update set
  title          = excluded.title,
  url            = excluded.url,
  platform       = excluded.platform,
  category       = excluded.category,
  body           = excluded.body,
  doc_updated_at = excluded.doc_updated_at,
  imported_at    = now();`
  );
  emitted++;
}
console.log('commit;');

console.error(
  `[import-docs] ${emitted} article(s) emitted from ${wanted.length} row(s)` +
    (skippedEmpty ? `, ${skippedEmpty} with empty body` : '') +
    (seen.size !== emitted ? ', duplicates collapsed' : '')
);
}
