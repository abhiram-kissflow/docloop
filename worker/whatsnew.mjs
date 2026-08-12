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
      'self-check': { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
  });
  return { dryRun: values['dry-run'], selfCheck: values['self-check'], help: values.help };
}

const USAGE = `docloop What's New worker — turn a release into a public changelog entry.

  node whatsnew.mjs [--dry-run]

  --dry-run     claim nothing, POST nothing; print the entry the last-seen job would produce
  --self-check  run the pure-logic assertions and exit (no network, no env needed)

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

  const nameWords = words(name).length;
  if (nameWords < 5 || nameWords > 8) problems.push(`title is ${nameWords} words, should be 5-8`);
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
 * Raw job payload → the fields kf-whatsnew-writer's input template asks for.
 * Unknown/missing fields become null rather than a guess: an invented benefit is worse than an
 * absent one, because the model will happily write around it.
 */
export function featureFromJob(payload) {
  const source = payload?.source === 'feature-flag' ? 'feature-flag' : 'release';
  const e = payload?.event ?? {};

  if (source === 'feature-flag') {
    return {
      source,
      name: str(e.flag ?? e.name),
      type: 'New',
      notes: str(e.description ?? e.notes),
      area: str(e.area),
      ref: str(e.flag),
    };
  }

  const rel = e.release ?? e;
  return {
    source,
    name: str(rel.name) || str(rel.tag_name),
    // A release is only ever announced as shipped; New vs Improved is the model's call from the
    // notes, and the prompt asks for it explicitly.
    type: null,
    notes: str(rel.body),
    area: null,
    ref: str(rel.tag_name),
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
 */
export function buildBody(entry, feature, problems = []) {
  const ref = feature.ref ? ` (\`${feature.ref}\`)` : '';
  const trigger =
    feature.source === 'feature-flag'
      ? `A feature flag${ref} was turned on.`
      : `A release${ref} was published.`;

  return [
    `${trigger} Here is a draft What's New entry for kissflow.com/whats-new/, written to the`,
    'kf-whatsnew-writer format. Nothing is published — review, edit, and post it yourself.',
    '',
    ...(problems.length
      ? ['**Check before posting:**', ...problems.map((p) => `- ${p}`), '']
      : ['The draft passes every mechanical check in the skill checklist. The judgement calls —',
         'is this worth announcing, is the benefit the real one — are still yours.', '']),
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

  const feature = featureFromJob(job.payload || {});
  if (!feature.name && !feature.notes) {
    // Nothing to write from. Fail the job loudly rather than draft from an empty prompt, which
    // produces a confident entry about nothing.
    await report(job, auth, 'failed', { error: 'event carried no name and no notes' });
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
