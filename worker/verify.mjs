#!/usr/bin/env node
// Self-check for the Docloop worker. No network, no `claude` binary needed.
//   cd /Users/abhiram/docloop/worker && node verify.mjs
// ponytail: node:assert instead of a test framework. Ceiling: no fixtures/mocks for the real
// subprocess, so the claude call and the POST are covered by a manual --dry-run run.
//
// The §6.1 false-positive side is NOT hand-written here. It comes from ../fixtures/pii.json,
// the file web/verify.mjs also reads (CONTRACT §6.7) — that shared file is the only thing
// making "both sides implement the same rule set" an executable claim rather than a comment.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  extractJson,
  scrubPatterns,
  parseFlags,
  buildPrompt,
  piiRule,
  PII_RULE_NAMES,
  PII_LIMITS,
  PII_PUBLIC_LABELS,
  capRawOutput,
  MAX_RAW_OUTPUT,
  buildAuditPrompt,
  applyAuditVerdict,
  auditPatterns,
} from './index.mjs';
import { areasForFile, rankAreas, pickArticles, buildBody } from './staleness.mjs';

let checks = 0;
// async-aware so the §6.3 fail-closed paths can be exercised; still exits non-zero on the
// first failure (an uncaught throw / rejection out of top-level await).
const ok = async (name, fn) => {
  await fn();
  checks++;
  console.log(`ok  ${name}`);
};

const PAYLOAD = { source: 'intercom', window_days: 30, patterns: [{ label: 'a' }] };

// ---- (a) extractJson -------------------------------------------------------

await ok('extractJson: bare JSON', () => {
  assert.deepEqual(extractJson(JSON.stringify(PAYLOAD)), PAYLOAD);
});

await ok('extractJson: fenced JSON', () => {
  const text = 'Sure thing.\n```json\n' + JSON.stringify(PAYLOAD, null, 2) + '\n```\n';
  assert.deepEqual(extractJson(text), PAYLOAD);
});

await ok('extractJson: --output-format json envelope with a "result" string', () => {
  const envelope = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '```json\n' + JSON.stringify(PAYLOAD) + '\n```',
    total_cost_usd: 0.42,
  });
  assert.deepEqual(extractJson(envelope), PAYLOAD);
});

await ok('extractJson: prose with JSON embedded', () => {
  const text = `Here are the patterns I found:\n${JSON.stringify(PAYLOAD)}\nLet me know if you want more.`;
  assert.deepEqual(extractJson(text), PAYLOAD);
});

await ok('extractJson: throws a clear error when there is no JSON', () => {
  assert.throws(() => extractJson('I could not reach Intercom, sorry.'), /could not find JSON/);
  assert.throws(() => extractJson(''), /no output/);
});

// §6.4: raw model output is never printed or written to disk, and this error reaches stderr,
// which launchd routes into worker/logs/worker.err.log.
await ok('extractJson: the parse error never echoes the raw model output', () => {
  const leaky = 'Sorry — priya@acmecorp.com at Acme Corp said the payroll board broke.';
  try {
    extractJson(leaky);
    assert.fail('expected a throw');
  } catch (err) {
    for (const frag of ['priya', 'acmecorp', 'Acme', 'payroll']) {
      assert.ok(!err.message.includes(frag), `parse error leaked "${frag}"`);
    }
    assert.match(err.message, /content withheld/);
  }
});

// FAIL-CLOSED: a failed run must ingest nothing. extractJson used to mine a partial payload out
// of an is_error:true envelope and main() POSTed it as a normal result — the one fail-open path.
await ok('extractJson: is_error:true is checked BEFORE unwrapping, and refuses', () => {
  const stringResult = JSON.stringify({
    type: 'result', subtype: 'error_during_execution', is_error: true,
    result: JSON.stringify(PAYLOAD),
  });
  assert.throws(() => extractJson(stringResult), /is_error/);
  // The object-`result` shape is the nasty one: the inner payload is a candidate in its own
  // right, so a check that only looked at the winning candidate would sail past the flag.
  const objectResult = JSON.stringify({ type: 'result', is_error: true, result: PAYLOAD });
  assert.throws(() => extractJson(objectResult), /is_error/);
  // is_error:false must still work.
  assert.deepEqual(
    extractJson(JSON.stringify({ type: 'result', is_error: false, result: PAYLOAD })),
    PAYLOAD
  );
});

// A model that narrates before answering used to cost a whole 6-hour cycle: the DECOY parsed
// first and won. Fail-closed, so never a data problem — purely a wasted cycle.
await ok('extractJson: prefers the real payload over a narrated decoy', () => {
  const text = 'Thinking: {"patterns": "none yet"}\nFinal answer:\n' + JSON.stringify(PAYLOAD);
  assert.deepEqual(extractJson(text), PAYLOAD);
  // Also when the decoy comes last but has no patterns ARRAY.
  const trailing = JSON.stringify(PAYLOAD) + '\nFor reference: {"patterns": "see above"}';
  assert.deepEqual(extractJson(trailing), PAYLOAD);
});

// REGRESSION: a real mining run failed here. The envelope's `result` string was not clean JSON
// (the model wrapped its answer), the candidate scan then ranged over the envelope's OWN metadata,
// and a modelUsage entry came back as the payload. The envelope must be unwrapped directly and its
// siblings must never be candidates — they are always metadata, never the answer.
await ok('extractJson: envelope siblings are never mistaken for the payload', () => {
  const siblings = {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 2.2084289999999998,
    usage: { input_tokens: 48, output_tokens: 11542 },
    modelUsage: {
      'claude-opus-5': {
        inputTokens: 48, outputTokens: 11542, cacheReadInputTokens: 1975118,
        costUSD: 2.2084289999999998, canonicalModel: 'claude-opus-5', provider: 'firstParty',
      },
    },
    permission_denials: [],
  };
  // The model wrapped its answer in prose and a fence — the exact shape that broke the real run.
  const wrapped = { ...siblings, result: 'Here is the payload:\n```json\n' + JSON.stringify(PAYLOAD) + '\n```' };
  assert.deepEqual(extractJson(JSON.stringify(wrapped)), PAYLOAD);

  // And when the result genuinely carries no JSON, it must THROW rather than hand back a
  // metadata object that happens to parse. Returning modelUsage as a payload is the failure.
  const garbage = { ...siblings, result: 'I could not complete the mining run this time.' };
  assert.throws(() => extractJson(JSON.stringify(garbage)), /could not find JSON/);
});

// ---- (a2) §6.6 input bounds ------------------------------------------------

await ok('§6.6 cap 1: raw stdout over 1 MB throws, with a length-only message', () => {
  assert.equal(MAX_RAW_OUTPUT, 64 * 1024);
  assert.equal(capRawOutput('{"patterns":[]}'), '{"patterns":[]}');
  try {
    capRawOutput('x'.repeat(MAX_RAW_OUTPUT + 1));
    assert.fail('expected a throw');
  } catch (err) {
    assert.match(err.message, /over the \d+-char cap/);
    assert.ok(!err.message.includes('xxxx'), 'cap error must not echo content');
  }
});

// ORDERING, asserted explicitly (§6.6 cap 3): the cap must run BEFORE extractJson, because
// extractJson has its own independent quadratic that no per-field cap can reach. The string
// below WOULD parse cleanly — if the cap error is what comes back, the ordering is right.
await ok('§6.6 cap 1 runs BEFORE extractJson (the only cover for jsonCandidates)', async () => {
  const wouldParse = JSON.stringify({ identity_findings: [] });
  const huge = wouldParse + '\n' + '{'.repeat(MAX_RAW_OUTPUT);
  assert.deepEqual(extractJson(wouldParse), { identity_findings: [] }); // parses on its own
  await assert.rejects(
    auditPatterns('/fake/claude', [{ label: 'x' }], async () => huge),
    /over the \d+-char cap/
  );
});

await ok('§6.6: the scrub is fast on capped-size non-matching input (EMAIL is quadratic)', () => {
  const p = { ...structuredClone(cleanShape()), description: 'no address here at all. '.repeat(80) };
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) scrubPatterns([p]);
  // 20 x a cap-sized description. Unbounded input is hours; anything under a second is proof
  // enough that the bound, not a cleverer regex, is what keeps this cheap.
  assert.ok(Date.now() - t0 < 2000, `scrub took ${Date.now() - t0} ms for 20 capped descriptions`);
});

// ---- (b) the §6.1 v4 rule set ----------------------------------------------

function cleanShape() {
  return {
    label: 'Approval step conditions unclear',
    description: 'Users cannot work out how conditional routing on an approval step is configured.',
    ticket_count: 12,
    questions: ['How do I add a condition to an approval step?', 'Why does my approval skip a step?'],
    suggestions: [{ type: 'update', body: 'The approval-step doc never shows a condition example.' }],
  };
}
const clean = cleanShape();

await ok('§6.1 v4: the six hard rules, in order, HANDLE gone', () => {
  assert.deepEqual(PII_RULE_NAMES, [
    'EMAIL', 'EMAIL_NO_TLD', 'EMAIL_OBFUSCATED', 'URL', 'TICKET_REF', 'DIGIT_RUN',
  ]);
  assert.ok(!PII_RULE_NAMES.includes('HANDLE'), 'HANDLE is demoted to the §6.3 audit prompt');
});

await ok('§6.1 v4: each rule fires on its own shape', () => {
  assert.equal(piiRule('Escalated by priya@acmecorp.consulting last week.'), 'EMAIL');
  assert.equal(piiRule('Login as priya@internal fails.'), 'EMAIL_NO_TLD');
  assert.equal(piiRule('Contact priya (at) acmecorp dot com about this.'), 'EMAIL_OBFUSCATED');
  assert.equal(piiRule('Mail priya at acmecorp dot com instead.'), 'EMAIL_OBFUSCATED');
  assert.equal(piiRule('Their tenant acmecorp.kissflow.com is affected.'), 'URL');
  assert.equal(piiRule('Also at //acmecorp.kissflow.com/app for tenants.'), 'URL');
  assert.equal(piiRule('See tenant.acme.co.uk for the steps.'), 'URL');
  // …while the same domain behind a generic public label is a public site, not a tenant.
  assert.equal(piiRule('See www.acme.co.uk for the steps.'), null);
  assert.equal(piiRule('Tracked as CONV-88213 internally.'), 'TICKET_REF');
  assert.equal(piiRule('Support was reached on +1 415 555 0134 about this.'), 'DIGIT_RUN');
});

await ok('§6.1 v4: TICKET_REF is a PREFIX ALLOWLIST with a REQUIRED separator', () => {
  for (const s of ['Tracked as CONV-88213.', 'Ref ZD_9930 today.', 'Opened INC-4471 now.',
                   'See TICKET-1201 for more.', 'Filed CASE_9001 yesterday.']) {
    assert.equal(piiRule(s), 'TICKET_REF', `must catch: ${s}`);
  }
  // No stop-list. These are permanently not our problem — including the separator-less shapes
  // the old rule ate, and the ones nobody has written yet.
  for (const s of ['ERR_1024 appears.', 'PR-1042 shipped.', 'AS_400 exports.', 'INC1234 is not one.',
                   'SHA256 digests.', 'ISO8601 timestamps.', 'HTTP 500 on submit.', 'AC_1024 seen.']) {
    assert.equal(piiRule(s), null, `must survive: ${s}`);
  }
});

await ok('§6.1 v4: PUBLIC_LABELS decides URL — every label above the registrable domain', () => {
  assert.deepEqual(PII_PUBLIC_LABELS.slice().sort(), [
    'academy', 'api', 'app', 'blog', 'community', 'developer', 'developers',
    'docs', 'help', 'learn', 'status', 'support', 'www',
  ]);
  // Bare registrable domains, and generic public labels on ANY domain — not just Kissflow's.
  // A host allowlist could never have allowed docs.zapier.com without growing per vendor.
  for (const host of [
    'kissflow.com', 'zapier.com', 'github.com', 'acme.co.uk',
    'help.kissflow.com', 'status.kissflow.com', 'academy.kissflow.com',
    'docs.zapier.com', 'support.google.com', 'www.acme.co.uk',
  ]) {
    assert.equal(piiRule(`The docs at ${host} cover this.`), null, `${host} must be allowed`);
    assert.equal(piiRule(`See https://${host}/some/page for details.`), null, `${host} path must be allowed`);
  }
  // A tenant label drops — on Kissflow and on third-party hosts alike. The last four are the
  // regressions this rule was rewritten for: a tenant hiding behind a generic prefix (checking
  // only labels[0] allowed it), an unlisted TLD, and an uppercased host (a closed lowercase TLD
  // list never saw it).
  for (const host of [
    'acmecorp.kissflow.com', 'acme.slack.com', 'contoso.sharepoint.com', 'tenant.acme.co.uk',
    'www.acmecorp.kissflow.com', 'app.acmecorp.kissflow.com',
    'acmelabs.notion.so', 'ACME.KISSFLOW.COM',
  ]) {
    assert.equal(piiRule(`Seen at ${host} repeatedly.`), 'URL', `${host} must drop`);
  }
});

await ok('§6.1 v4: EMAIL_OBFUSCATED keeps only the unambiguous forms', () => {
  assert.equal(piiRule('Reach priya [at] acmecorp for the trace.'), 'EMAIL_OBFUSCATED');
  assert.equal(piiRule('Contact priya (at) acmecorp dot com.'), 'EMAIL_OBFUSCATED');
  // The bare "X at domain.tld" arm is GONE: it collided with the English preposition.
  // KNOWN RESIDUE (§6.2): on a TWO-label host this is now undetected. URL only matches three
  // labels or more, so it no longer backstops this the way it did when a TLD list was in play.
  // It cannot be fixed with a rule — "priya at acmecorp.com" and "look at kissflow.com" are the
  // same shape, and only whether the left token is a person's name separates them. §6.3's job.
  assert.equal(piiRule('Mail priya at acmecorp.com instead.'), null);
  // A tenant host (three labels) is still caught, which is the case that carries identity.
  assert.equal(piiRule('Mail priya at acme.acmecorp.com instead.'), 'URL');
  assert.equal(piiRule('The help article at help.kissflow.com/approvals is stale.'), null);
  assert.equal(piiRule('People look at kissflow.com for pricing.'), null);
  assert.equal(piiRule('Look at settings to change it.'), null);
});

await ok('§6.1 v4: @-tokens are NOT a hard rule any more (demoted to §6.3)', () => {
  for (const s of ['Users ask what @initiator resolves to.', 'The @approver variable is missing.',
                   '@me as a filter shortcut.', 'the @mention feature', '@assignee and @here',
                   '@everyone and @channel are unclear.']) {
    assert.equal(piiRule(s), null, `must survive: ${s}`);
  }
  // And the cost, stated honestly: a real handle now walks through §6.1. That is what the
  // §6.3 pass is for, and fixtures/pii.json records it as known-undetectable.
  assert.equal(piiRule('Raised by user:@jdoe in Slack.'), null);
});

// ---- (b2) CONTRACT §6.7 shared fixtures ------------------------------------

const FIXTURES = JSON.parse(readFileSync(new URL('../fixtures/pii.json', import.meta.url), 'utf8'));

// §6.5/§6.7: every fixture runs in EVERY field class. questions[1] and suggestions[1] are
// deliberate — index 0 alone would pass a guard that only ever checks the first element.
const FIELD_CLASSES = [
  ['label', (p, v) => (p.label = v)],
  ['description', (p, v) => (p.description = v)],
  ['questions[0]', (p, v) => (p.questions[0] = v)],
  ['questions[1]', (p, v) => (p.questions[1] = v)],
  ['suggestions[0].body', (p, v) => (p.suggestions[0].body = v)],
  ['suggestions[1].body', (p, v) => p.suggestions.push({ type: 'create', body: v })],
];
const rx = (where) => new RegExp(where.replace(/[[\]().]/g, '\\$&'));

await ok('§6.7: fixtures/pii.json is well-formed and covers both failure modes', () => {
  assert.ok(Array.isArray(FIXTURES) && FIXTURES.length >= 25, 'fixture file looks truncated');
  const counts = { drop: 0, keep: 0, 'known-undetectable': 0 };
  for (const f of FIXTURES) {
    assert.equal(typeof f.s, 'string', 'every fixture needs an "s"');
    assert.ok(f.expect in counts, `bad expect value: ${f.expect}`);
    // Every fixture is run in the label field class, which §6.6 caps at LIMITS.label.
    assert.ok(f.s.length <= PII_LIMITS.label, `fixture longer than the label cap: ${f.s}`);
    counts[f.expect]++;
  }
  assert.ok(counts.drop >= 6, 'need at least one drop fixture per §6.1 rule');
  assert.ok(counts.keep >= 12, '§6.7 requires the twelve legitimate strings');
  assert.ok(counts['known-undetectable'] >= 3, '§6.2 categories must be recorded, never asserted caught');
});

await ok('§6.7: every fixture x every field class, against the COMPOSED guard', () => {
  for (const [where, mutate] of FIELD_CLASSES) {
    for (const f of FIXTURES) {
      const p = cleanShape();
      mutate(p, f.s);
      const { patterns, dropped } = scrubPatterns([p]);
      if (f.expect === 'drop') {
        assert.equal(patterns.length, 0, `${where}: expected a DROP (documented rule: ${f.rule})`);
        assert.equal(dropped.length, 1);
        assert.match(dropped[0].field, rx(where), `${where}: dropped on the wrong field`);
      } else {
        // keep AND known-undetectable must both survive. A known-undetectable fixture that
        // starts getting caught means the rules have gone over-broad again.
        assert.equal(
          patterns.length, 1,
          `${where}: must SURVIVE (expect=${f.expect}) but rule ${dropped[0]?.rule} ate it — ${f.s}`
        );
      }
    }
  }
});

// §6.4: the drop path is the one path guaranteed to be holding PII.
await ok('scrubPatterns: the drop record carries NO label and NO offending value', () => {
  const p = cleanShape();
  p.label = 'Acme Corp SSO outage';
  p.description = 'Seen at https://acmecorp.kissflow.com/workflow/AC_1024 again.';
  const { dropped } = scrubPatterns([p]);
  assert.deepEqual(Object.keys(dropped[0]).sort(), ['field', 'rule']);
  const printed = JSON.stringify(dropped);
  for (const frag of ['Acme', 'acmecorp', 'kissflow.com', 'AC_1024', 'https']) {
    assert.ok(!printed.includes(frag), `drop record leaked "${frag}"`);
  }
});

// ---- (b3) §6.6 caps + no-silent-coercion in the scrub ----------------------

await ok('§6.6: scrubPatterns caps the patterns ARRAY itself', () => {
  const many = Array.from({ length: PII_LIMITS.patterns + 1 }, () => cleanShape());
  const { patterns, dropped } = scrubPatterns(many);
  assert.equal(patterns.length, 0);
  assert.deepEqual(dropped, [{ field: 'patterns', rule: 'CAP' }]);
  assert.equal(scrubPatterns(Array.from({ length: PII_LIMITS.patterns }, cleanShape)).patterns.length,
    PII_LIMITS.patterns);
});

await ok('§6.6: every per-string / per-array cap is a DROP, never a truncation', () => {
  const cases = [
    ['label', (p) => (p.label = 'x'.repeat(PII_LIMITS.label + 1))],
    ['description', (p) => (p.description = 'x'.repeat(PII_LIMITS.description + 1))],
    ['questions[1]', (p) => (p.questions[1] = 'x'.repeat(PII_LIMITS.question + 1))],
    ['suggestions[0].body', (p) => (p.suggestions[0].body = 'x'.repeat(PII_LIMITS.suggestionBody + 1))],
    ['questions', (p) => (p.questions = Array.from({ length: PII_LIMITS.questions + 1 }, () => 'q?'))],
    ['suggestions', (p) => (p.suggestions = Array.from({ length: PII_LIMITS.suggestions + 1 },
      () => ({ type: 'update', body: 'b' })))],
    ['ticket_count', (p) => (p.ticket_count = PII_LIMITS.ticketCount + 1)],
  ];
  for (const [field, mutate] of cases) {
    const p = cleanShape();
    mutate(p);
    const { patterns, dropped } = scrubPatterns([p]);
    assert.equal(patterns.length, 0, `${field} over cap must DROP the pattern`);
    assert.deepEqual(dropped, [{ field, rule: 'CAP' }]);
  }
  // ticket_count at the int4 ceiling is fine; one past it is not.
  const edge = cleanShape();
  edge.ticket_count = PII_LIMITS.ticketCount;
  assert.equal(scrubPatterns([edge]).patterns.length, 1);
});

// Defect E. Every one of these used to STORE a pattern that looked legitimate — an empty
// questionnaire, no error, no log line, no drop count — while the scrub next door logged loudly.
await ok('no silent coercion: every shape failure is a dropped[] entry with a rule', () => {
  const cases = [
    ['questions', (p) => (p.questions = 'How do I do X?')],
    ['questions', (p) => (p.questions = { a: 'How do I do X?' })],
    ['questions[1]', (p) => (p.questions[1] = { text: 'How do I do X?' })],
    ['questions[1]', (p) => (p.questions[1] = 42)],
    ['suggestions', (p) => (p.suggestions = 'Add a section about approvals.')],
    ['suggestions[0]', (p) => (p.suggestions[0] = 'Add a section about approvals.')],
    ['suggestions[0].body', (p) => delete p.suggestions[0].body],
    ['suggestions[0].type', (p) => (p.suggestions[0].type = 'delete')],
    ['description', (p) => (p.description = { text: 'a description' })],
    ['ticket_count', (p) => (p.ticket_count = 'nope')],
    ['ticket_count', (p) => (p.ticket_count = 1.5)],
    ['ticket_count', (p) => (p.ticket_count = -1)],
    ['label', (p) => (p.label = { text: 'a label' })],
    ['label', (p) => (p.label = '   ')],
  ];
  for (const [field, mutate] of cases) {
    const p = cleanShape();
    mutate(p);
    const { patterns, dropped } = scrubPatterns([p]);
    assert.equal(patterns.length, 0, `${field}: must DROP, not coerce`);
    assert.deepEqual(dropped, [{ field, rule: 'COERCE' }]);
  }
  assert.deepEqual(scrubPatterns(['not an object']), {
    patterns: [], dropped: [{ field: 'pattern', rule: 'COERCE' }],
  });
  assert.deepEqual(scrubPatterns(undefined), { patterns: [], dropped: [] });
});

await ok('scrubPatterns: a clean pattern passes through unchanged', () => {
  const { patterns, dropped } = scrubPatterns([cleanShape()]);
  assert.equal(dropped.length, 0);
  // The one normalisation: article_external_id is materialised as null when absent, so every
  // suggestion has the same shape by the time it reaches the API.
  const expected = cleanShape();
  expected.suggestions = expected.suggestions.map((s) => ({ ...s, article_external_id: null }));
  assert.deepEqual(patterns[0], expected);

  // Absent optional fields default without complaint — a default is not a coercion.
  const { patterns: minimal } = scrubPatterns([{ label: 'Bulk import fails' }]);
  assert.deepEqual(minimal[0], {
    label: 'Bulk import fails', description: '', ticket_count: 0, questions: [], suggestions: [],
  });
});

await ok('scrubPatterns: article_external_id survives the whitelist rebuild and IS scrubbed', () => {
  // Carried through — a field the rebuild forgets is silently lost.
  const linked = cleanShape();
  linked.suggestions = [{ type: 'update', body: 'Needs a condition example.', article_external_id: 'api:GET /user/2/{account_id}/' }];
  const { patterns } = scrubPatterns([linked]);
  assert.equal(patterns[0].suggestions[0].article_external_id, 'api:GET /user/2/{account_id}/');

  // …and guarded like every other string: a tenant URL in this field drops the whole pattern.
  const leaky = cleanShape();
  leaky.suggestions = [{ type: 'update', body: 'See the tenant page.', article_external_id: 'https://acmecorp.kissflow.com/help/x' }];
  const { patterns: none, dropped } = scrubPatterns([leaky]);
  assert.equal(none.length, 0);
  assert.equal(dropped[0].rule, 'URL');

  // A real doc URL is NOT a leak — community/developers are generic public labels, so the
  // index's own external_ids pass the guard. If they did not, grounding would be impossible.
  const ok2 = cleanShape();
  ok2.suggestions = [{ type: 'update', body: 'Stale.', article_external_id: 'https://community.kissflow.com/t/h7h9qtx/email-actions' }];
  assert.equal(scrubPatterns([ok2]).patterns.length, 1);
});

// ---- (c) adversarial second pass, §6.3 -------------------------------------

const twoPatterns = [
  { ...cleanShape(), label: 'Approval step conditions unclear' },
  { ...cleanShape(), label: 'Payroll board access lost after migration' },
];

await ok('buildAuditPrompt: asks only the §6.3 question and leaks no provenance', () => {
  const p = buildAuditPrompt(twoPatterns);
  assert.match(p, /identity_findings/);
  assert.match(p, /person's name/);
  assert.match(p, /company, brand, or customer organisation name/);
  assert.match(p, /tenant, workspace, account, or environment name/);
  assert.match(p, /speech attributed to a particular user/);
  assert.match(p, /STRICT JSON/);
  assert.match(p, /Approval step conditions unclear/); // the payload itself is included
  // §6.1 v4 demoted HANDLE here, so the prompt must actually carry the job.
  assert.match(p, /@-token/);
  assert.match(p, /@jdoe/);
  assert.match(p, /@initiator/);
  assert.match(p, /must NOT\n?be flagged|must NOT be flagged/);
  // Told nothing about how the payload was produced.
  assert.ok(!/Intercom/i.test(p), 'audit prompt must not mention where the data came from');
  assert.ok(!/scrub|regex|PII rule/i.test(p), 'audit prompt must not describe the first pass');
});

await ok('applyAuditVerdict: drops named patterns, keeps the rest', () => {
  const r = applyAuditVerdict(twoPatterns, {
    identity_findings: ['Payroll board access lost after migration'],
  });
  assert.equal(r.dropped, 1);
  assert.equal(r.patterns.length, 1);
  assert.equal(r.patterns[0].label, 'Approval step conditions unclear');
});

await ok('applyAuditVerdict: empty findings keep everything; a bare array is accepted', () => {
  assert.equal(applyAuditVerdict(twoPatterns, { identity_findings: [] }).patterns.length, 2);
  assert.equal(applyAuditVerdict(twoPatterns, []).patterns.length, 2);
  assert.equal(applyAuditVerdict(twoPatterns, ['Approval step conditions unclear']).dropped, 1);
});

await ok('applyAuditVerdict: FAILS CLOSED on anything it cannot interpret', () => {
  for (const junk of [null, undefined, 'ok', 42, {}, { identity_findings: 'nope' }, { findings: [] }]) {
    assert.throws(() => applyAuditVerdict(twoPatterns, junk), /adversarial pass/);
  }
  assert.throws(() => applyAuditVerdict(twoPatterns, { identity_findings: [7] }), /non-string/);
  assert.throws(
    () => applyAuditVerdict(twoPatterns, { identity_findings: ['a label that is not here'] }),
    /not in the payload/
  );
});

await ok('applyAuditVerdict: errors never echo a label', () => {
  try {
    applyAuditVerdict(twoPatterns, { identity_findings: ['Acme Corp payroll board'] });
    assert.fail('expected a throw');
  } catch (err) {
    assert.ok(!/Acme/.test(err.message), 'error message leaked the offending label');
  }
});

await ok('auditPatterns: runs the second call and applies its verdict', async () => {
  const seen = [];
  const fakeRun = async (bin, prompt) => {
    seen.push(prompt);
    return '```json\n{"identity_findings":["Payroll board access lost after migration"]}\n```';
  };
  const r = await auditPatterns('/fake/claude', twoPatterns, fakeRun);
  assert.equal(seen.length, 1, 'exactly one second, independent call');
  assert.equal(r.dropped, 1);
  assert.equal(r.patterns.length, 1);
});

await ok('auditPatterns: FAILS CLOSED when the call errors or returns junk', async () => {
  await assert.rejects(
    auditPatterns('/fake/claude', twoPatterns, async () => {
      throw new Error('timeout');
    }),
    /timeout/
  );
  await assert.rejects(
    auditPatterns('/fake/claude', twoPatterns, async () => 'I could not do that.'),
    /could not find JSON/
  );
  await assert.rejects(auditPatterns('/fake/claude', twoPatterns, async () => ''), /no output/);
  // A failed audit run is a failed audit, not an empty verdict.
  await assert.rejects(
    auditPatterns('/fake/claude', twoPatterns, async () =>
      JSON.stringify({ is_error: true, result: '{"identity_findings":[]}' })),
    /is_error/
  );
});

await ok('auditPatterns: an empty payload needs no call', async () => {
  const r = await auditPatterns('/fake/claude', [], async () => {
    throw new Error('should not be called');
  });
  assert.deepEqual(r, { patterns: [], dropped: 0 });
});

// ---- (d) flags -------------------------------------------------------------

await ok('parseFlags: defaults (the §6.3 audit is ON unless explicitly skipped)', () => {
  assert.deepEqual(parseFlags([]), { dryRun: false, skipAudit: false, days: 30, top: 5, help: false });
});

await ok('parseFlags: --skip-audit is opt-in only', () => {
  assert.equal(parseFlags(['--skip-audit']).skipAudit, true);
  assert.equal(parseFlags(['--dry-run']).skipAudit, false);
});

await ok('parseFlags: overrides', () => {
  const f = parseFlags(['--dry-run', '--days=7', '--top=3']);
  assert.deepEqual(f, { dryRun: true, skipAudit: false, days: 7, top: 3, help: false });
  assert.equal(parseFlags(['--days', '14']).days, 14);
  assert.equal(parseFlags(['--days=0']).days, 30); // garbage falls back
  assert.equal(parseFlags(['--top=abc']).top, 5);
});

// ---- prompt sanity ---------------------------------------------------------

await ok('buildPrompt: carries window/top and states the PII rule', () => {
  const p = buildPrompt(14, 3);
  assert.match(p, /LAST 14 DAYS/);
  assert.match(p, /TOP 3 clusters/);
  assert.match(p, /NO email addresses/);
  assert.match(p, /mcp__claude_ai_Intercom__search_conversations/);
  assert.match(p, /STRICT JSON/);
});

console.log(`\n${checks} checks passed`);

// ---- B1 staleness (CONTRACT §3, BLUEPRINT §5) --------------------------------

const PREFIXES = {
  'components/web/src/form': { area: 'forms-fields', votes: 90, share: 0.8 },
  'components/web/src/form/design': { area: 'pages-ui', votes: 20, share: 0.7 },
  'components/web/src/flow_dashboard': { area: 'reports-analytics', votes: 30, share: 0.9 },
};

await ok('staleness: longest prefix wins, and a prefix must end on a path boundary', () => {
  // The more specific directory knows better than its parent.
  assert.deepEqual(areasForFile('components/web/src/form/design/constant.js', PREFIXES), ['pages-ui']);
  assert.deepEqual(areasForFile('components/web/src/form/table/row.ts', PREFIXES), ['forms-fields']);
  // Boundary: `.../form` must NOT swallow `.../formatting`. Without the boundary check a rename
  // silently reassigns a whole directory to the wrong area.
  assert.deepEqual(areasForFile('components/web/src/formatting/x.ts', PREFIXES), []);
  assert.deepEqual(areasForFile('server/unrelated/thing.go', PREFIXES), []);
  assert.deepEqual(areasForFile('', PREFIXES), []);
});

await ok('staleness: areas rank by how many files hit them', () => {
  const ranked = rankAreas(
    ['components/web/src/form/a.ts', 'components/web/src/form/b.ts', 'components/web/src/flow_dashboard/c.tsx', 'no/mapping/here.ts'],
    PREFIXES
  );
  assert.deepEqual(ranked.map((r) => r.area), ['forms-fields', 'reports-analytics']);
  assert.equal(ranked[0].files.length, 2);
});

await ok('staleness: articles are picked by area, capped, and never duplicated', () => {
  const articles = [
    { external_id: 'a1', title: 'Table', features: ['area:forms-fields'] },
    { external_id: 'a2', title: 'Button', features: ['area:forms-fields'] },
    { external_id: 'a3', title: 'Reports overview', features: ['area:reports-analytics'] },
    { external_id: 'a4', title: 'Unrelated', features: ['area:portals'] },
    { external_id: 'a5', title: 'Both', features: ['area:forms-fields', 'area:reports-analytics'] },
  ];
  const ranked = rankAreas(['components/web/src/form/a.ts', 'components/web/src/form/b.ts', 'components/web/src/flow_dashboard/c.tsx'], PREFIXES);
  const picked = pickArticles(ranked, articles, 10);
  // forms-fields first (2 files beat 1), its articles by title — Both < Button < Table — then
  // reports-analytics. Stable ordering matters: repeated pushes to one area must surface the same
  // articles rather than a rotating subset.
  assert.deepEqual(picked.map((p) => p.article.external_id), ['a5', 'a2', 'a1', 'a3']);
  // An article in two affected areas is raised ONCE, under the most-affected one.
  assert.equal(picked.filter((p) => p.article.external_id === 'a5').length, 1);
  assert.equal(picked.find((p) => p.article.external_id === 'a5').area, 'forms-fields');
  // The cap is honoured.
  assert.equal(pickArticles(ranked, articles, 2).length, 2);
});

await ok('staleness: the body survives the PII guard and never overclaims', () => {
  const body = buildBody({
    area: 'forms-fields',
    files: ['components/web/src/comment/draft.store.ts', 'components/common/src/form/table/row.model.ts'],
    repo: 'kissflow/kf-xg-frontend',
    commits: 3,
  });
  // Full paths with multi-dot filenames must NOT trip the guard — that is exactly what 9b2f9df fixed.
  assert.equal(piiRule(body), null, 'a body naming real repo paths must survive §6.1');
  assert.match(body, /may need/, 'B1 states a doc MAY need review, never that it IS stale');
  assert.ok(!/is stale|out of date/i.test(body), 'no staleness assertion without reading the doc');
});
