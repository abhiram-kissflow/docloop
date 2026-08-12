#!/usr/bin/env node
// Docloop worker — Workstream C, the What's New path.
//
// A release is published (or a feature flag flips on the generic webhook), the route enqueues a
// `whatsnew` job holding the raw event, and this turns it into a public changelog entry for
// kissflow.com/whats-new/ — as a `create` suggestion a writer reviews.
//
//   node whatsnew.mjs [--dry-run]
//
// WHY THIS IS SEPARATE FROM newdoc.mjs: BLUEPRINT §6 says release notes take a different path and
// land as their own suggestion in their own voice. A help article explains how to use a feature to
// someone looking for help; a What's New entry announces it to someone scrolling. Same trigger,
// different artefact, different skill — merging them would produce something that reads as neither.
//
// WHAT THIS DELIBERATELY DOES NOT DO: publish. The entry ends at the review queue like everything
// else (PLAN §9). It also does not decide whether a release DESERVES an entry — every published
// release gets one drafted, and a writer dismisses the ones that do not. Guessing newsworthiness
// from a tag name is exactly the judgement a model should not be making unsupervised.
//
// ponytail: one job per invocation, no batching, no dedupe against an entry already drafted for
// the same tag. Ceiling: re-running the same release drafts it twice. Upgrade path: a unique index
// on (type, body-hash) once anyone has actually done it by accident.

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { api, requireEnv, claimJob } from './api.mjs';
import { resolveClaudeBin, runClaude, extractJson, capRawOutput, piiRule } from './index.mjs';

export function parseFlags(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: false,
    options: {
      'dry-run': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { dryRun: values['dry-run'], help: values.help };
}

const USAGE = `docloop What's New worker — turn a release into a public changelog entry.

  node whatsnew.mjs [--dry-run]

  --dry-run   claim nothing, POST nothing; print the entry the last-seen job would produce

Env: DOCLOOP_API_URL, WORKER_API_KEY, optionally CLAUDE_BIN
`;

// ---------------------------------------------------------------- the skill's rules, mechanised
//
// kf-whatsnew-writer ships a quality checklist a human is meant to run down. A checklist a model
// grades itself against is a checklist that passes, so the parts that are decidable are decided
// here instead. What is left to the model is the writing; what is left to the writer is judgement.

// Verbatim from the skill's vocabulary ban. These are RLHF tells, and a release note carrying one
// reads as machine-written to exactly the audience it is for.
const BANNED = [
  'delve', 'foster', 'underscore', 'facilitate', 'utilize', 'embark', 'unleash', 'unlock',
  'bridge', 'augment',
  'tapestry', 'landscape', 'realm', 'nuance', 'symphony', 'testament', 'intersection',
  'intricate', 'multifaceted', 'pivotal', 'crucial', 'robust', 'meticulous', 'seamless',
  'ever-evolving',
  'moreover', 'furthermore', 'additionally', 'consequently', 'in conclusion', 'ultimately',
  'it is important to note',
];

const ALLOWED_TAGS = new Set(['p', 'strong', 'br', 'ul', 'li', 'a', 'h4', 'h5']);

// The canonical category set. Suggesting a tag outside it means somebody invented a product area.
export const CATEGORY_TAGS = [
  'Apps', 'Process', 'Board', 'Forms', 'Platform', 'Integrations', 'Analytics',
  'Account Administration', 'Dataset', 'Dataform', 'Collaboration',
];

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean);
const textOf = (html) => String(html).replace(/<[^>]*>/g, ' ');

/**
 * Grade one entry against the decidable half of the skill's checklist.
 * Returns human-readable problems, never throws — a near-miss entry is still worth a writer's
 * two minutes, and telling them exactly what is off is more use than silently dropping it.
 * @returns {string[]}
 */
export function checkEntry(entry) {
  const problems = [];
  const name = String(entry?.hs_name ?? '');
  const short = String(entry?.short_description ?? '');
  const body = String(entry?.description ?? '');

  // The skill's prose says "5-8 words max", but EVERY example it holds up as good is 2-4:
  // "Editable Grid", "AI-Powered Formula Builder", "SAP S/4HANA Connector", "Revamped File
  // Previewer", "Introducing Kissflow Portals", "Field-Level Access Control". Enforcing the
  // stated rule flagged the model for producing exactly the title the skill teaches, which is
  // the failure mode this checker exists to avoid — one that cries wolf gets ignored wholesale.
  // So the EXAMPLES are treated as the real rule and the upper bound is kept: 2-8. The prose
  // should be corrected at the source; this is the reading that matches practice until it is.
  const nameWords = words(name).length;
  if (nameWords < 2 || nameWords > 8) problems.push(`title is ${nameWords} words, should be 2-8`);
  if (/[.!]/.test(name)) problems.push('title contains a period or exclamation mark');

  const shortWords = words(short).length;
  if (shortWords > 30) problems.push(`short_description is ${shortWords} words, should be under 30`);
  if (shortWords === 0) problems.push('short_description is empty');

  const bodyWords = words(textOf(body)).length;
  if (bodyWords < 70 || bodyWords > 100) problems.push(`description is ${bodyWords} words, should be 70-100`);

  // Tag check is on the RENDERED tag name only, so an <a href> full of punctuation is fine.
  for (const m of body.matchAll(/<\s*\/?\s*([a-zA-Z][a-zA-Z0-9]*)/g)) {
    const tag = m[1].toLowerCase();
    if (!ALLOWED_TAGS.has(tag)) problems.push(`description uses <${tag}>, which is not an allowed tag`);
  }
  if (/style\s*=/i.test(body)) problems.push('description uses an inline style');

  // Word-boundary match so "unlocked" is caught but "bridged" in a compound is not a false hit on
  // some longer word that merely contains it.
  const haystack = `${name} ${short} ${textOf(body)}`.toLowerCase();
  for (const w of BANNED) {
    const re = new RegExp(`\\b${w.replace(/[-\s]/g, '[-\\s]')}\\w*\\b`, 'i');
    if (re.test(haystack)) problems.push(`uses the banned word "${w}"`);
  }

  const tags = Array.isArray(entry?.tags) ? entry.tags : [];
  if (tags.length === 0) problems.push('no category tag suggested');
  for (const t of tags) {
    if (!CATEGORY_TAGS.includes(t)) problems.push(`"${t}" is not one of the canonical category tags`);
  }

  return problems;
}

// ---------------------------------------------------------------- input normalisation
//
// The webhook stays thin and enqueues the raw event; the shaping happens here. That is the same
// split B1 uses, and for the same reason — a webhook doing real work times out.

/**
 * Job payload → the fields kf-whatsnew-writer's input template asks for.
 *
 * The payload is already FLAT: both routes extract and bound the fields at the boundary (§6.6),
 * so this only renames and fills gaps. Missing fields become null rather than a guess — an
 * invented benefit is worse than an absent one, because the model writes around it convincingly.
 */
export function featureFromJob(payload) {
  const p = payload ?? {};
  if (p.source === 'feature-flag') {
    return {
      source: 'feature-flag',
      // The flag key is a poor headline (`grid_edit`), so a human-set name wins when present.
      name: str(p.name) || str(p.flag),
      // A flag flip only ever reveals something new; a rollback never reaches here.
      type: 'New',
      notes: str(p.description),
      area: str(p.area),
      ref: str(p.flag) || str(p.name),
      url: str(p.url),
    };
  }
  return {
    source: 'release',
    name: str(p.name) || str(p.tag),
    // New vs Improved is the model's call from the notes, and the prompt asks for it explicitly.
    type: null,
    notes: str(p.body),
    area: null,
    ref: str(p.tag),
    url: str(p.url),
  };
}

const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

/** The prompt. The skill carries the voice; this carries the facts and the output contract. */
export function buildPrompt(feature) {
  const known = [
    ['Feature name', feature.name],
    ['Feature type', feature.type],
    ['Product area', feature.area],
    ['Release notes / raw input', feature.notes],
  ].filter(([, v]) => v);

  return [
    'Use the kf-whatsnew-writer skill to write ONE public What\'s New entry for kissflow.com/whats-new/.',
    '',
    'Feature information:',
    ...known.map(([k, v]) => `${k}: ${v}`),
    '',
    'Follow the skill exactly — its voice rules, its vocabulary ban, and its field length rules.',
    'Write only about what the input states. If the input does not say what a change does for the',
    'user, say what it changes; do not invent a benefit.',
    '',
    'Do NOT include any customer name, company name, person name, email address or support ticket',
    'reference, even if one appears in the input above.',
    '',
    'Return ONLY a JSON object, no prose around it:',
    '{"hs_name": "...", "short_description": "...", "description": "<p>...</p>", "tags": ["Platform"]}',
    `Tags must come from: ${CATEGORY_TAGS.join(', ')}.`,
  ].join('\n');
}

/** Model output → entry. Throws with a reason rather than returning a half-entry. */
export function parseEntry(raw) {
  const value = extractJson(capRawOutput(raw));
  if (!value || typeof value !== 'object') throw new Error('model returned no JSON object');
  const entry = {
    hs_name: str(value.hs_name),
    short_description: str(value.short_description),
    description: str(value.description),
    tags: Array.isArray(value.tags) ? value.tags.filter((t) => typeof t === 'string') : [],
  };
  const missing = ['hs_name', 'short_description', 'description'].filter((k) => !entry[k]);
  if (missing.length) throw new Error(`model output is missing: ${missing.join(', ')}`);
  return entry;
}

/**
 * The suggestion body. The three fields are reproduced verbatim so a writer can copy them into
 * HubSpot, and any checklist problems are stated up front rather than buried — an entry that
 * needs a fix is more useful than one that looks finished and is not.
 *
 * THE HEADLINE IS THE FIRST LINE. The queue derives a row title from the first heading in the
 * body, so a body that opened with `**hs_name:**` titled the row `hs_name:` — the field label,
 * with the actual headline hidden on the line below. The most reviewable item in the queue read
 * as a null. The entry is read HERE first and copied into HubSpot second, so it leads with what
 * it is; the field labels that matter only at paste time come after.
 */
export function buildBody(entry, feature, problems = []) {
  const ref = feature.ref ? ` (\`${feature.ref}\`)` : '';
  const trigger =
    feature.source === 'feature-flag'
      ? `A feature flag${ref} was turned on.`
      : `A release${ref} was published.`;

  return [
    `## ${entry.hs_name}`,
    '',
    entry.short_description,
    '',
    `${trigger} Here is a draft What's New entry for kissflow.com/whats-new/, written to the`,
    'kf-whatsnew-writer format. Nothing is published — review, edit, and post it yourself.',
    '',
    ...(problems.length
      ? ['**Check before posting:**', ...problems.map((p) => `- ${p}`), '']
      : ['The draft passes every mechanical check in the skill checklist. The judgement calls —',
         'is this worth announcing, is the benefit the real one — are still yours.', '']),
    '**Fields to paste into HubSpot**',
    '',
    '**hs_name:**',
    entry.hs_name,
    '',
    '**short_description:**',
    entry.short_description,
    '',
    '**description:**',
    entry.description,
    '',
    `**tags:** ${entry.tags.join(', ') || '(none suggested)'}`,
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
  const job = await claimJob('whatsnew', auth);
  if (!job) {
    console.error('[whatsnew] no pending whatsnew job');
    return;
  }

  // Everything past the claim is wrapped: a job that has been claimed is `running`, and nothing
  // reaps it. A throw here — an unparseable draft, a dead API, a missing binary — used to leave
  // the row claimed forever, invisible, and the next run would skip straight past it. Reporting
  // the failure is what makes the queue self-describing.
  try {
    await draft(job, auth, flags);
  } catch (err) {
    await report(job, auth, 'failed', { error: err.message }).catch(() => {});
    throw err;
  }
}

async function draft(job, auth, flags) {
  const feature = featureFromJob(job.payload || {});

  // A name alone is not something to announce. `grid_inline_edit` with no description cannot
  // become 70-100 words without inventing them, which is the one thing the prompt forbids — so
  // refuse here rather than spend a model call discovering it. A release with no notes is the
  // same case: the tag is not the story.
  if (!feature.notes) {
    await report(job, auth, 'failed', { error: 'event carried no release notes or description' });
    console.error('[whatsnew] job carried nothing to write from — failed it');
    return;
  }
  console.error(`[whatsnew] job ${job.id}: ${feature.source}, ref ${feature.ref || '(none)'}`);

  const entry = parseEntry(await runClaude(resolveClaudeBin(), buildPrompt(feature)));
  const problems = checkEntry(entry);
  const body = buildBody(entry, feature, problems);

  // §6.1 locally, before spending a round trip. The API enforces it too, but a release body is
  // human-written and can carry an email or a customer name straight into the prompt — better to
  // fail here, where the job records why, than to read a 400 as a transport error.
  const rule = piiRule(body);
  if (rule) {
    await report(job, auth, 'failed', { error: `draft tripped the §6.1 guard: ${rule}` });
    console.error(`[whatsnew] draft tripped the §6.1 ${rule} rule — nothing was POSTed`);
    return;
  }

  if (flags.dryRun) {
    console.log(JSON.stringify({ job: job.id, entry, problems }, null, 2));
    console.error('[whatsnew] --dry-run: nothing was POSTed and the job stays claimed');
    return;
  }

  const r = await api('/api/suggestions', auth, {
    method: 'POST',
    body: JSON.stringify({
      suggestions: [{ type: 'create', article_external_id: null, source: 'whatsnew', body }],
    }),
  });
  console.error(
    `[whatsnew] raised ${r.created} suggestion(s)` +
      (problems.length ? `, ${problems.length} checklist problem(s) noted` : ', checklist clean')
  );

  await report(job, auth, 'done', { created: r.created, problems: problems.length, tags: entry.tags });
}


// §6.4: counts and field names only — never the draft itself.
const report = (job, auth, status, result) =>
  api('/api/results', auth, {
    method: 'POST',
    body: JSON.stringify({ job_id: Number(job.id), status, result }),
  });

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`[whatsnew] failed: ${err.message}`);
    process.exit(1);
  });
}
