#!/usr/bin/env node
// Docloop web self-check. Zero DB, zero network, no test framework.
//   cd web && node verify.mjs
// Exits non-zero on the first failed assertion.
//
// ponytail: node:assert + a counter instead of a test runner. Ceiling: no isolation,
// first failure aborts the run. Upgrade path: `node --test` if this grows past ~20 cases.

import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  verifyGithubSignature,
  bearerOk,
  validateIngest,
  piiRule,
  PII_RULE_NAMES,
  PII_LIMITS,
  PII_PUBLIC_LABELS,
} from './lib/pure.mjs';

let n = 0;
const check = (name, fn) => {
  fn();
  n++;
  console.log(`  ok  ${name}`);
};

const SECRET = 's3cret-webhook-key';
const sign = (secret, body) =>
  'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');

// ---------------------------------------------------------------- (a) HMAC
console.log('a) GitHub signature verification');

const body = JSON.stringify({ ref: 'refs/heads/main', repository: { name: 'kf-xg-frontend' } });
const good = sign(SECRET, body);

check('correctly-signed payload verifies', () => {
  assert.equal(verifyGithubSignature(SECRET, body, good), true);
});

check('tampered body does not verify', () => {
  const tampered = body.replace('main', 'evil');
  assert.notEqual(tampered, body);
  assert.equal(verifyGithubSignature(SECRET, tampered, good), false);
});

check('tampered signature does not verify', () => {
  const flipped = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
  assert.equal(verifyGithubSignature(SECRET, body, flipped), false);
});

check('wrong secret does not verify', () => {
  assert.equal(verifyGithubSignature('other-secret', body, good), false);
});

check('missing signature header is rejected', () => {
  assert.equal(verifyGithubSignature(SECRET, body, null), false);
  assert.equal(verifyGithubSignature(SECRET, body, ''), false);
});

check('missing secret FAILS CLOSED (never open)', () => {
  assert.equal(verifyGithubSignature(undefined, body, good), false);
  assert.equal(verifyGithubSignature('', body, good), false);
});

check('length mismatch does not throw (timingSafeEqual guard)', () => {
  assert.equal(verifyGithubSignature(SECRET, body, 'sha256=deadbeef'), false);
  assert.equal(verifyGithubSignature(SECRET, body, 'x'.repeat(500)), false);
});

// -------------------------------------------------------------- (b) bearer
console.log('b) Bearer token compare');

const TOKEN = 'worker-api-key-abc123';

check('correct bearer token is accepted', () => {
  assert.equal(bearerOk(TOKEN, `Bearer ${TOKEN}`), true);
  assert.equal(bearerOk(TOKEN, `bearer ${TOKEN}`), true);
});

check('wrong token is rejected', () => {
  assert.equal(bearerOk(TOKEN, 'Bearer worker-api-key-abc124'), false);
  assert.equal(bearerOk(TOKEN, 'Bearer short'), false);
});

check('absent / malformed header is rejected', () => {
  assert.equal(bearerOk(TOKEN, null), false);
  assert.equal(bearerOk(TOKEN, ''), false);
  assert.equal(bearerOk(TOKEN, TOKEN), false); // no "Bearer " prefix
  assert.equal(bearerOk(TOKEN, 'Basic ' + TOKEN), false);
});

check('unset expected token FAILS CLOSED (never open)', () => {
  assert.equal(bearerOk(undefined, `Bearer ${TOKEN}`), false);
  assert.equal(bearerOk('', 'Bearer '), false);
  assert.equal(bearerOk(undefined, undefined), false);
});

// -------------------------------------------------------------- (c) ingest
console.log('c) /api/ingest/patterns body validation');

const goodBody = {
  source: 'intercom',
  window_days: 30,
  patterns: [
    {
      label: 'Cannot reset SSO password',
      description: 'Users ask how to recover access when SSO is enforced.',
      ticket_count: 12,
      questions: ['How do I reset my password with SSO on?', 'Who can re-enable my account?'],
      suggestions: [{ type: 'update', body: 'Add an SSO recovery section to the account article.' }],
    },
  ],
};

check('good payload is accepted and normalised', () => {
  const r = validateIngest(goodBody);
  assert.equal(r.ok, true);
  assert.equal(r.value.patterns.length, 1);
  assert.equal(r.value.patterns[0].questions.length, 2);
  assert.equal(r.value.patterns[0].suggestions[0].type, 'update');
  assert.equal(r.value.window_days, 30);
});

// ------------------------------------------------------- (c2) PII guard §6.1 v4
console.log('c2) PII guard — CONTRACT §6.1 v4 rule set');

check('the six hard rules, in order, HANDLE gone', () => {
  assert.deepEqual(PII_RULE_NAMES, [
    'EMAIL', 'EMAIL_NO_TLD', 'EMAIL_OBFUSCATED', 'URL', 'TICKET_REF', 'DIGIT_RUN',
  ]);
  assert.ok(!PII_RULE_NAMES.includes('HANDLE'), 'HANDLE is demoted to the §6.3 audit prompt');
});

check('each rule fires on its own shape', () => {
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

check('TICKET_REF is a PREFIX ALLOWLIST with a REQUIRED separator', () => {
  for (const s of ['Tracked as CONV-88213.', 'Ref ZD_9930 today.', 'Opened INC-4471 now.',
                   'See TICKET-1201 for more.', 'Filed CASE_9001 yesterday.']) {
    assert.equal(piiRule(s), 'TICKET_REF', `must catch: ${s}`);
  }
  for (const s of ['ERR_1024 appears.', 'PR-1042 shipped.', 'AS_400 exports.', 'INC1234 is not one.',
                   'SHA256 digests.', 'ISO8601 timestamps.', 'HTTP 500 on submit.', 'AC_1024 seen.']) {
    assert.equal(piiRule(s), null, `must survive: ${s}`);
  }
});

check('PUBLIC_LABELS decides URL — every label above the registrable domain', () => {
  assert.deepEqual(PII_PUBLIC_LABELS.slice().sort(), [
    'academy', 'api', 'app', 'blog', 'community', 'developer', 'developers',
    'docs', 'help', 'learn', 'status', 'support', 'www',
  ]);
  for (const host of [
    'kissflow.com', 'zapier.com', 'github.com', 'acme.co.uk',
    'help.kissflow.com', 'status.kissflow.com', 'academy.kissflow.com',
    'docs.zapier.com', 'support.google.com', 'www.acme.co.uk',
  ]) {
    assert.equal(piiRule(`The docs at ${host} cover this.`), null, `${host} must be allowed`);
    assert.equal(piiRule(`See https://${host}/some/page for details.`), null, `${host} path must be allowed`);
  }
  for (const host of [
    'acmecorp.kissflow.com', 'acme.slack.com', 'contoso.sharepoint.com', 'tenant.acme.co.uk',
    'www.acmecorp.kissflow.com', 'app.acmecorp.kissflow.com',
    'acmelabs.notion.so', 'ACME.KISSFLOW.COM',
  ]) {
    assert.equal(piiRule(`Seen at ${host} repeatedly.`), 'URL', `${host} must drop`);
  }
});

check('EMAIL_OBFUSCATED keeps only the unambiguous forms', () => {
  assert.equal(piiRule('Reach priya [at] acmecorp for the trace.'), 'EMAIL_OBFUSCATED');
  assert.equal(piiRule('Contact priya (at) acmecorp dot com.'), 'EMAIL_OBFUSCATED');
  // KNOWN RESIDUE (§6.2): a bare two-label host is not matched by URL, so this is undetected.
  // Not fixable with a rule — see CONTRACT §6.2. §6.3's job.
  assert.equal(piiRule('Mail priya at acmecorp.com instead.'), null);
  assert.equal(piiRule('Mail priya at acme.acmecorp.com instead.'), 'URL');
  assert.equal(piiRule('The help article at help.kissflow.com/approvals is stale.'), null);
  assert.equal(piiRule('Look at settings to change it.'), null);
});

check('@-tokens are NOT a hard rule any more (demoted to §6.3)', () => {
  for (const s of ['Users ask what @initiator resolves to.', 'The @approver variable is missing.',
                   '@me as a filter shortcut.', 'the @mention feature', '@assignee and @here',
                   '@everyone and @channel are unclear.']) {
    assert.equal(piiRule(s), null, `must survive: ${s}`);
  }
});

// ------------------------------------------- (c3) CONTRACT §6.7 shared fixtures
console.log('c3) §6.7 shared fixtures — the parity check with worker/verify.mjs');

// The SAME file worker/verify.mjs reads. Two files, six rules, no shared source and no build
// step: this is the only thing that turns "both sides implement the same rule set" into an
// executable claim. Divergence becomes a failing self-check instead of a silent asymmetry.
const FIXTURES = JSON.parse(readFileSync(new URL('../fixtures/pii.json', import.meta.url), 'utf8'));

// §6.5/§6.7: every fixture runs in EVERY field class. questions[1] and suggestions[1] are
// deliberate — index 0 alone would pass a guard that only ever checks the first element.
const FIELD_CLASSES = [
  ['label', (b, v) => (b.patterns[0].label = v)],
  ['description', (b, v) => (b.patterns[0].description = v)],
  ['questions[0]', (b, v) => (b.patterns[0].questions[0] = v)],
  ['questions[1]', (b, v) => (b.patterns[0].questions[1] = v)],
  ['suggestions[0].body', (b, v) => (b.patterns[0].suggestions[0].body = v)],
  ['suggestions[1].body', (b, v) => b.patterns[0].suggestions.push({ type: 'create', body: v })],
];

check('fixtures/pii.json is well-formed and covers both failure modes', () => {
  assert.ok(Array.isArray(FIXTURES) && FIXTURES.length >= 25, 'fixture file looks truncated');
  const counts = { drop: 0, keep: 0, 'known-undetectable': 0 };
  for (const f of FIXTURES) {
    assert.equal(typeof f.s, 'string', 'every fixture needs an "s"');
    assert.ok(f.expect in counts, `bad expect value: ${f.expect}`);
    assert.ok(f.s.length <= PII_LIMITS.label, `fixture longer than the label cap: ${f.s}`);
    counts[f.expect]++;
  }
  assert.ok(counts.drop >= 6, 'need at least one drop fixture per §6.1 rule');
  assert.ok(counts.keep >= 12, '§6.7 requires the twelve legitimate strings');
  assert.ok(counts['known-undetectable'] >= 3, '§6.2 categories must be recorded, never asserted caught');
});

check('every fixture x every field class, against the COMPOSED guard', () => {
  for (const [where, mutate] of FIELD_CLASSES) {
    for (const f of FIXTURES) {
      const b = structuredClone(goodBody);
      mutate(b, f.s);
      const r = validateIngest(b);
      if (f.expect === 'drop') {
        assert.equal(r.ok, false, `${where}: expected a 400 (documented rule: ${f.rule})`);
        assert.match(r.error, /PII guard/);
        assert.ok(r.error.includes(where), `${where}: 400 must name the field, got: ${r.error}`);
        assert.ok(!r.error.includes(f.s), 'the 400 must never echo the offending value');
      } else {
        // keep AND known-undetectable must both survive. A known-undetectable fixture that
        // starts being rejected means the rules have gone over-broad again.
        assert.equal(r.ok, true, `${where}: must SURVIVE (expect=${f.expect}) — got: ${r.error}`);
      }
    }
  }
});

check('the 400 names the rule and the field but never the value', () => {
  const b = structuredClone(goodBody);
  b.patterns[0].label = 'Acme Corp SSO outage';
  b.patterns[0].description = 'Seen at https://acmecorp.kissflow.com/workflow/AC_1024 again.';
  const r = validateIngest(b);
  assert.equal(r.ok, false);
  assert.match(r.error, /patterns\[0\]\.description trips rule URL/);
  for (const frag of ['Acme', 'acmecorp', 'AC_1024', 'https']) {
    assert.ok(!r.error.includes(frag), `400 leaked "${frag}"`);
  }
});

check('a second suggestion body is guarded too (not just suggestions[0])', () => {
  const b = structuredClone(goodBody);
  b.patterns[0].suggestions.push({ type: 'create', body: 'Tracked as CONV-88213 internally.' });
  const r = validateIngest(b);
  assert.equal(r.ok, false);
  assert.match(r.error, /suggestions\[1\]\.body trips rule TICKET_REF/);
});

check('source is in the guarded string set', () => {
  // Not a realistic payload — proof that the collection reaches this field at all.
  // A tenant host, not a bare domain — §6.1 allows acme.com, so it would prove nothing.
  assert.equal(
    validateIngest({ source: 'https://acmecorp.kissflow.com', patterns: [{ label: 'x' }] }).ok,
    false
  );
});

check('the whole request is rejected, never partially accepted', () => {
  const b = structuredClone(goodBody);
  b.patterns.push({ label: 'Perfectly clean second pattern', questions: ['How do I retry?'] });
  b.patterns[0].description = 'Tracked as CONV-88213 internally.';
  const r = validateIngest(b);
  assert.equal(r.ok, false);
  assert.equal(r.value, undefined);
});

// ------------------------------------------------------ (c4) §6.6 input bounds
console.log('c4) §6.6 input bounds — the guard must not become the outage');

check('the patterns ARRAY itself is capped (every other cap is per-element)', () => {
  const b = structuredClone(goodBody);
  const one = b.patterns[0];
  b.patterns = Array.from({ length: PII_LIMITS.patterns + 1 }, (_, i) => ({
    ...structuredClone(one), label: `Pattern number ${i}`,
  }));
  const r = validateIngest(b);
  assert.equal(r.ok, false);
  assert.match(r.error, /patterns exceeds the 100-entry cap/);
  b.patterns = b.patterns.slice(0, PII_LIMITS.patterns);
  assert.equal(validateIngest(b).ok, true);
});

check('every per-string / per-array cap is a 400, never a truncation', () => {
  const cases = [
    [/label exceeds 80/, (b) => (b.patterns[0].label = 'x'.repeat(PII_LIMITS.label + 1))],
    [/description exceeds the 2000-char cap/, (b) =>
      (b.patterns[0].description = 'x'.repeat(PII_LIMITS.description + 1))],
    [/questions\[1\] exceeds the 500-char cap/, (b) =>
      (b.patterns[0].questions[1] = 'x'.repeat(PII_LIMITS.question + 1))],
    [/suggestions\[0\]\.body exceeds the 5000-char cap/, (b) =>
      (b.patterns[0].suggestions[0].body = 'x'.repeat(PII_LIMITS.suggestionBody + 1))],
    [/questions exceeds the 50-entry cap/, (b) =>
      (b.patterns[0].questions = Array.from({ length: PII_LIMITS.questions + 1 }, () => 'How?'))],
    [/suggestions exceeds the 20-entry cap/, (b) =>
      (b.patterns[0].suggestions = Array.from({ length: PII_LIMITS.suggestions + 1 },
        () => ({ type: 'update', body: 'b' })))],
  ];
  for (const [pattern, mutate] of cases) {
    const b = structuredClone(goodBody);
    mutate(b);
    const r = validateIngest(b);
    assert.equal(r.ok, false, `expected a 400 for ${pattern}`);
    assert.match(r.error, pattern);
    assert.equal(r.value, undefined, 'over-cap input is a 400, never a truncated accept');
  }
});

check('ticket_count is bounded at int4 (an over-range value rolls back the WHOLE batch)', () => {
  const over = structuredClone(goodBody);
  over.patterns[0].ticket_count = PII_LIMITS.ticketCount + 1;
  const r = validateIngest(over);
  assert.equal(r.ok, false);
  assert.match(r.error, /ticket_count exceeds 2147483647/);
  // 9e15 is a Number.isInteger() — the old check let it straight through to INSERT.
  const huge = structuredClone(goodBody);
  huge.patterns[0].ticket_count = 9e15;
  assert.equal(validateIngest(huge).ok, false);
  const edge = structuredClone(goodBody);
  edge.patterns[0].ticket_count = PII_LIMITS.ticketCount;
  assert.equal(validateIngest(edge).ok, true);
});

check('schema violations are rejected', () => {
  const cases = [
    null,
    'nope',
    [],
    {},
    { source: 'intercom' },
    { source: 'intercom', patterns: [] },
    { source: '', patterns: [{ label: 'x', questions: [] }] },
    { source: 'intercom', patterns: [{ description: 'no label' }] },
    { source: 'intercom', patterns: [{ label: 'x'.repeat(81) }] },
    { source: 'intercom', patterns: [{ label: 'x', ticket_count: -1 }] },
    { source: 'intercom', patterns: [{ label: 'x', questions: 'not an array' }] },
    { source: 'intercom', patterns: [{ label: 'x', questions: [''] }] },
    { source: 'intercom', patterns: [{ label: 'x', suggestions: [{ type: 'delete', body: 'b' }] }] },
    { source: 'intercom', patterns: [{ label: 'x', suggestions: [{ type: 'update' }] }] },
  ];
  for (const c of cases) {
    const r = validateIngest(c);
    assert.equal(r.ok, false, `expected rejection for ${JSON.stringify(c)}`);
    assert.equal(typeof r.error, 'string');
  }
});

check('minimal valid payload defaults cleanly', () => {
  const r = validateIngest({ source: 'intercom', patterns: [{ label: 'Bulk import fails' }] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.patterns[0], {
    label: 'Bulk import fails',
    description: '',
    ticket_count: 0,
    questions: [],
    suggestions: [],
  });
  assert.equal(r.value.window_days, 30);
});

console.log(`\n${n} checks passed.`);
