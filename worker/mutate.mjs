#!/usr/bin/env node
// CONTRACT §6.5 — the mutation test, as a RUNNABLE SCRIPT.
//   cd /Users/abhiram/docloop/worker && node mutate.mjs
//
// "An obligation stated in prose is satisfied by inspection." Both verify.mjs files claim to
// guard the §6.1 rule set in every field class. This script breaks the guard on purpose, one
// change at a time, and requires the self-check to notice. A self-check that passes when the
// thing it guards is broken is worse than no self-check, because it is trusted.
//
// Mutants (§6.5): delete each field-list entry; disable each §6.1 rule; make the scrub drop
// NOTHING; make the scrub drop EVERYTHING. The drop-everything mutant is the one people forget —
// a scrub that drops everything leaks nothing, so a leak-only fixture set passes it. That mutant
// is killed only by fixtures/pii.json's must-survive entries.
//
// It NEVER writes inside the repo: sources are copied to a fresh mkdtemp() under the OS temp dir,
// the mutation is applied to the COPY, and the UNMODIFIED verify.mjs runs against it.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');

// Everything the two self-checks need to run standalone. Zero npm deps on either side, so a flat
// copy is a complete, runnable tree.
//
// EVERY worker module is staged, not an explicit list. The list bit twice: verify.mjs grew an
// import (staleness.mjs, then newdoc.mjs + api.mjs) and the baseline failed on a clean copy, which
// reports as "mutation test FAILED" — a genuinely confusing way to learn a file is missing. A
// worker module that verify.mjs does not import costs one file copy; a missing one costs a
// misleading red build. Enumerate the directory instead of remembering to update a list.
const SOURCES = [
  ...readdirSync(path.join(REPO, 'worker'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `worker/${f}`),
  // Same lesson, one directory over: web/verify.mjs grew an import of scripts/import-docs.mjs
  // and the baseline failed on a clean copy, reporting as "mutation test FAILED" rather than
  // "file missing". Enumerate the directory instead of remembering to update a list.
  ...readdirSync(path.join(REPO, 'scripts'))
    .filter((f) => f.endsWith('.mjs'))
    .map((f) => `scripts/${f}`),
  'web/lib/pure.mjs',
  'web/verify.mjs',
  'fixtures/pii.json',
];

const WORKER_RULES = 'worker/index.mjs';
const WEB_RULES = 'web/lib/pure.mjs';

// §6.1 requires the two sides to implement the SAME rule set, and each rule is one line in a
// table that is byte-for-byte identical in both files — which is exactly what makes "delete the
// line" a reliable mutation.
const RULE_LINES = [
  "  ['EMAIL', RULE_EMAIL],",
  "  ['EMAIL_NO_TLD', RULE_EMAIL_NO_TLD],",
  "  ['EMAIL_OBFUSCATED', RULE_EMAIL_OBFUSCATED],",
  "  ['URL', RULE_URL],",
  "  ['TICKET_REF', RULE_TICKET_REF],",
  "  ['DIGIT_RUN', RULE_DIGIT_RUN],",
];

const WORKER_FIELD_LINES = [
  "      ['label', v.label],",
  "      ['description', v.description],",
  '      ...v.questions.map((q, i) => [`questions[${i}]`, q]),',
  '      ...v.suggestions.map((s, i) => [`suggestions[${i}].body`, s.body]),',
];

const WEB_FIELD_LINES = [
  "  fields.push(['source', b.source]);",
  '    fields.push([`${at}.label`, p.label]);',
  '    fields.push([`${at}.description`, description]);',
  '    for (let j = 0; j < questions.length; j++) fields.push([`${at}.questions[${j}]`, questions[j]]);',
  '      fields.push([`${at}.suggestions[${j}].body`, suggestions[j].body]);',
];

// Both files carry this signature line verbatim (it is inside the shared block), so the
// drop-nothing / drop-everything mutants are the same edit on either side.
const PII_RULE_FN = 'export function piiRule(s) {';

/** @param {'worker'|'web'} side */
const verifyDir = (side) => (side === 'worker' ? 'worker' : 'web');

/** @type {{ name: string, side: 'worker'|'web', file: string, find: string, replace: string }[]} */
const MUTANTS = [];

for (const side of /** @type {const} */ (['worker', 'web'])) {
  const file = side === 'worker' ? WORKER_RULES : WEB_RULES;
  for (const line of RULE_LINES) {
    MUTANTS.push({
      name: `${side}: disable rule ${line.trim().split("'")[1]}`,
      side, file, find: `\n${line}`, replace: '',
    });
  }
  MUTANTS.push({
    name: `${side}: scrub drops NOTHING`,
    side, file, find: PII_RULE_FN, replace: `${PII_RULE_FN} return null;`,
  });
  MUTANTS.push({
    name: `${side}: scrub drops EVERYTHING`,
    side, file, find: PII_RULE_FN, replace: `${PII_RULE_FN} return 'MUTANT';`,
  });
}

for (const line of WORKER_FIELD_LINES) {
  MUTANTS.push({
    name: `worker: delete field-list entry ${line.trim()}`,
    side: 'worker', file: WORKER_RULES, find: `\n${line}`, replace: '',
  });
}
for (const line of WEB_FIELD_LINES) {
  MUTANTS.push({
    name: `web: delete field-list entry ${line.trim().slice(0, 60)}`,
    side: 'web', file: WEB_RULES, find: `\n${line}`, replace: '',
  });
}

// ---------------------------------------------------------------- runner

function stage() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'docloop-mutate-'));
  if (dir.startsWith(REPO)) throw new Error('refusing to run: temp dir is inside the repo');
  for (const rel of SOURCES) {
    const dest = path.join(dir, rel);
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(path.join(REPO, rel), dest);
  }
  return dir;
}

/** @returns {{ code: number, out: string }} */
function runVerify(dir, side) {
  try {
    const out = execFileSync(process.execPath, ['verify.mjs'], {
      cwd: path.join(dir, verifyDir(side)),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    return { code: 0, out };
  } catch (err) {
    return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

function applyMutation(dir, m) {
  const target = path.join(dir, m.file);
  const src = readFileSync(target, 'utf8');
  const at = src.indexOf(m.find);
  if (at === -1) {
    // A drifted anchor is a silently vacuous mutation test, so it is a hard failure, not a skip.
    throw new Error(`mutation anchor not found in ${m.file}: ${JSON.stringify(m.find.slice(0, 70))}`);
  }
  if (src.indexOf(m.find, at + 1) !== -1 && m.replace === '') {
    throw new Error(`mutation anchor is ambiguous in ${m.file}: ${JSON.stringify(m.find.slice(0, 70))}`);
  }
  writeFileSync(target, src.slice(0, at) + m.replace + src.slice(at + m.find.length));
}

// ---------------------------------------------------------------- go

let failures = 0;

// 0. §6.1 parity: the two rule tables must be byte-for-byte identical. They deploy separately
// and cannot share a module, so nothing but this check and fixtures/pii.json makes that true.
{
  const block = (rel) => {
    const s = readFileSync(path.join(REPO, rel), 'utf8');
    const a = s.indexOf('// ===== BEGIN SHARED');
    const b = s.indexOf('// ===== END SHARED');
    if (a < 0 || b < 0) throw new Error(`shared-block markers missing in ${rel}`);
    return s.slice(a, b);
  };
  if (block(WORKER_RULES) === block(WEB_RULES)) {
    console.log('ok    §6.1 rule block is byte-for-byte identical on both sides');
  } else {
    console.log('FAIL  §6.1 rule block has DRIFTED between worker/index.mjs and web/lib/pure.mjs');
    failures++;
  }
}

// 1. Baseline: the unmutated copy must be green on both sides. If it is not, every "killed"
// verdict below is meaningless.
{
  const dir = stage();
  try {
    for (const side of ['worker', 'web']) {
      const r = runVerify(dir, side);
      if (r.code === 0) {
        console.log(`ok    baseline ${side}/verify.mjs passes on the staged copy`);
      } else {
        console.log(`FAIL  baseline ${side}/verify.mjs does NOT pass on a clean copy\n${r.out}`);
        failures++;
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// 2. Every mutant must be KILLED (verify.mjs exits non-zero).
for (const m of MUTANTS) {
  const dir = stage();
  try {
    applyMutation(dir, m);
    const r = runVerify(dir, m.side);
    if (r.code !== 0) {
      console.log(`ok    killed  — ${m.name}`);
    } else {
      console.log(`FAIL  SURVIVED — ${m.name}`);
      console.log('        the self-check passed with the guard broken, so it is not guarding this.');
      failures++;
    }
  } catch (err) {
    console.log(`FAIL  ${m.name}: ${err.message}`);
    failures++;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log(`\n${MUTANTS.length} mutants, ${failures} failure(s)`);
if (failures) {
  console.error('mutation test FAILED — a self-check that passes when the thing it guards is broken');
  process.exit(1);
}
console.log('mutation test passed: every mutant was killed');
