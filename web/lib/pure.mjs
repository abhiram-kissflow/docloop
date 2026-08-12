// Pure, dependency-free logic shared by the API routes and verify.mjs.
// ponytail: plain .mjs (not .ts) so `node verify.mjs` can import it with zero build
// step and zero Next.js in the graph. Ceiling: no compile-time types here — JSDoc only.
// Upgrade path: move to .ts + tsx/tsup once there is a real build pipeline.

import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time string compare that never throws on length mismatch.
 * timingSafeEqual() requires equal-length buffers, so guard the length first.
 * (The length check itself leaks length, not content — acceptable for tokens.)
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 * @returns {boolean}
 */
export function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length || ba.length === 0) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Verify a GitHub webhook signature over the RAW request body.
 * Fails CLOSED: no secret configured => reject.
 * @param {string | undefined} secret        GITHUB_WEBHOOK_SECRET
 * @param {string} rawBody                   exact bytes of the request body
 * @param {string | null | undefined} header X-Hub-Signature-256, "sha256=<hex>"
 * @returns {boolean}
 */
export function verifyGithubSignature(secret, rawBody, header) {
  if (!secret || typeof rawBody !== 'string' || !header) return false;
  const expected = 'sha256=' + createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
  return safeEqual(expected, header);
}

/**
 * Check an `Authorization: Bearer <token>` header against an expected token.
 * Fails CLOSED: unset/empty expected token => reject (never open).
 * @param {string | undefined} expected
 * @param {string | null | undefined} header
 * @returns {boolean}
 */
export function bearerOk(expected, header) {
  if (!expected || !header) return false;
  const m = /^Bearer[ ]+(.+)$/i.exec(header.trim());
  if (!m) return false;
  return safeEqual(expected, m[1]);
}

// ---------------------------------------------------------------- PII rules (CONTRACT §6.1 v4)
//
// ===== BEGIN SHARED §6.1 BLOCK — byte-for-byte identical in worker/index.mjs and web/lib/pure.mjs =====
// The two sides deploy separately (Vercel vs. the Mac worker) so they cannot share a module, and
// §6.1 requires them to implement the SAME rule set. Change anything between the BEGIN and END
// markers in BOTH files in the same commit. fixtures/pii.json is the executable parity check
// (§6.7) and `node worker/mutate.mjs` diffs the two blocks byte-for-byte.
//
// Governing principle (§6.1 v4): a rule may be a hard drop ONLY if the side it enumerates is
// finite and under our control.
//   * URL enumerates the generic public subdomain LABELS that are ALLOWED (PUBLIC_LABELS), plus
//     bare registrable domains. The unbounded side — every possible tenant label — is rejected.
//   * TICKET_REF enumerates the known ticket PREFIXES, so ERR_1024, PR-1042, AS_400, SHA256,
//     ISO8601 and HTTP 500 are permanently not our problem — no stop-list, nothing to patch.
//   * HANDLE is GONE, demoted to the §6.3 audit prompt. @jdoe and @initiator are shape-identical,
//     people cannot be enumerated, and Kissflow ships new @-variables every release, so a hard
//     rule would have a scheduled future failure.
//
// Every regex is NON-GLOBAL and used with .test(), except the /g ones, which are consumed ONLY
// through .matchAll(). A /g regex reused with .test() carries lastIndex between calls and
// silently skips matches — §6.1 forbids introducing that bug.
//
// Complexity (§6.6): EMAIL is the quadratic rule — unanchored greedy class then a required
// literal. It is deliberately NOT rewritten to be cleverer; §6.6 bounds the INPUT instead
// (LIMITS below, plus the 1 MB raw-stdout cap in the worker). RULE_URL is alternation over
// bounded host tokens and measures ~0.2 ms on 40 KB.

// §6.6 input bounds. Over the cap is a DROP (worker) or a 400 (API) — never a truncation.
// The patterns[] cap is not optional: every other cap is per-element, so 100,000 minimal
// patterns would pass all of them.
const LIMITS = {
  patterns: 100,
  label: 80,
  description: 2000,
  question: 500,
  suggestionBody: 5000,
  questions: 50,
  suggestions: 20,
  ticketCount: 2147483647, // §2 declares patterns.ticket_count integer/int4
};

// §6.1: identity lives in the SUBDOMAIN LABEL, never in the registrable domain.
//   acmecorp.kissflow.com / acme.slack.com / contoso.sharepoint.com  the label IS the customer
//   kissflow.com / zapier.com / github.com                           bare domain, identifies nobody
//   help.kissflow.com / docs.zapier.com / support.google.com         generic public label
// So the ALLOWED side is these thirteen generic English words — not a list of hosts. A host
// allowlist enumerates the wrong thing: it grows per vendor and per Kissflow subdomain, which is
// the exception treadmill relocated from the drop side to the allow side. This set does not move
// when Kissflow adds an integration partner or a writer cites a new vendor — only if the web
// invents a new convention for public subdomains. It also sees tenant identity on THIRD-PARTY
// hosts, which a Kissflow-only host allowlist structurally could not.
const PUBLIC_LABELS = new Set(
  'www docs help support community developer developers api blog status app learn academy'.split(' ')
);

// ponytail: registrable-domain detection is LABEL COUNTING plus this short list — two labels is
// bare, and three is bare when the last two are a public suffix, so `example.co.uk` reads as a
// bare domain rather than label `example` on `co.uk`. There is no Public Suffix List in Node and
// §8 forbids adding the dependency.
// Ceiling: an exotic multi-part suffix that is not listed (`example.pvt.k12.ma.us`) is misread as
// a subdomain and therefore DROPS — a lost legitimate string, never a leak. Safe direction.
// Upgrade path: a real PSL the day that costs us a fixture.
const MULTI_PART_SUFFIXES = new Set(['co.uk', 'co.in', 'com.au', 'co.nz', 'co.jp', 'com.br', 'co.za']);

// A hostname sitting in ordinary prose, with no scheme. It must carry at least THREE labels.
// That one requirement replaces both a closed TLD list and case-sensitivity, each of which was
// its own leak: an unlisted TLD (acmelabs.notion.so) and an uppercased one (ACME.KISSFLOW.COM)
// both escaped the rule entirely, and the TLD list was itself a business-dependent enumeration
// on the ALLOW side — the thing §6.1's governing principle forbids.
// Three labels is the right test: a two-label host is a bare registrable domain, which §6.1
// allows anyway, so declining to match it costs nothing — while every tenant shape this rule
// exists to catch has three or more. It also preserves what the TLD list was really protecting:
// "…the final step.In addition…" is a missing space rather than a hostname, and has two labels,
// so it never matches regardless of case.
// The inner label quantifier is BOUNDED to 63, the DNS limit, for the same reason EMAIL's is
// bounded to 64: an unbounded `*` nested inside `{2,}` and followed by a required literal
// backtracks across the whole string from every start offset. On a long run of one character it
// measured 1250=3ms, 2500=11ms, 5000=54ms — quadratic, on a rule that had nothing to do with
// email. Bounding costs no real hostname and makes it linear.
// The negative lookbehind excludes a dotted token preceded by `/` — that is a FILE PATH, not a
// host. B1 puts repo paths in suggestion bodies, and without this `src/comment/draft.store.ts`
// reads as the hostname `draft.store.ts` and silently drops the whole suggestion. A hostname in
// prose is never preceded by a slash; a filename inside a path always is.
// Residual (§6.2): a BARE multi-dot filename at a token boundary — `config.staging.json` with no
// directory — still reads as a host and drops. B1 always emits full repo-relative paths, so it
// does not hit this, and dropping is the safe direction anyway.
const HOST_IN_PROSE = /(?<![\/\w.])(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.){2,}[A-Za-z]{2,}\b/g;
const HOST_AFTER_SCHEME = /https?:\/\/([^\s/?#"'<>)\]]+)/gi;
const HOST_PROTOCOL_REL = /(?:^|[\s(<"'[])\/\/([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
const HOST_WWW = /\bwww\.[A-Za-z0-9.-]*[A-Za-z0-9]/gi;

// The single gate every hostname decision goes through.
function hostAllowed(raw) {
  const labels = String(raw)
    .toLowerCase()
    .replace(/^[^@/]*@/, '') // userinfo
    .replace(/:\d+$/, '') // port
    .replace(/\.$/, '') // fully-qualified trailing dot
    .split('.');
  if (labels.length < 2) return false; // not a host we can reason about
  const bare = MULTI_PART_SUFFIXES.has(labels.slice(-2).join('.')) ? 3 : 2;
  if (labels.length <= bare) return true; // bare registrable domain
  // EVERY label above the registrable domain must be generic — not just the first. Checking only
  // labels[0] let a tenant hide behind a public prefix: www.acmecorp.kissflow.com was ALLOWED
  // while the same host without the prefix dropped correctly.
  return labels.slice(0, labels.length - bare).every((l) => PUBLIC_LABELS.has(l));
}

// A host in ADDRESS position (local@host, "x (at) host") is an identifier for a PERSON, not a
// reference to a public page, so the label logic deliberately does not rescue it — §6.1's
// must-NOT-catch column for the three EMAIL rules is empty, and priya@kissflow.com must drop even
// though kissflow.com is a bare public domain. Only prose-position hosts consult it.
// §6.6: the quantifiers are BOUNDED, and that is what removes the quadratic — not the input caps.
// An unbounded greedy `+` before a required literal backtracks from every offset; RFC 5321 caps a
// local part at 64 chars and a domain at 255, so bounding costs no real address. Measured on 80 KB
// of non-matching text: 10,192 ms unbounded -> 17 ms bounded, with byte-identical detection.
// The input caps stay — they are right for the database and the dashboard — but they are no longer
// what stands between this rule and an outage.
const RULE_EMAIL = (s) => /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,255}\.[A-Za-z]{2,}/.test(s);
// priya@internal — an @ with a local part and a bare hostname carrying no dot at all. The
// lookahead keeps this disjoint from EMAIL so that neither rule is dead weight behind the other.
const RULE_EMAIL_NO_TLD = (s) => /[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{2,255}(?![A-Za-z0-9.-])/.test(s);
// Only the UNAMBIGUOUS obfuscations: "(at)", "[at]", and "X at Y dot Z". The bare
// "X at domain.tld" arm is deliberately absent — it collides with the English preposition and
// it is what ate "The help article at help.kissflow.com/approvals is stale". Cost is near zero:
// a plain "priya at acmecorp.com" is still caught by URL on the hostname.
const RULE_EMAIL_OBFUSCATED = (s) =>
  /[A-Za-z0-9._%+-]\s*[([{]\s*[Aa][Tt]\s*[)\]}]\s*[A-Za-z0-9._%+-]/.test(s) ||
  // {1,64} not `+`: the local part is bounded by RFC 5321 anyway, and an unbounded greedy class
  // before a required \s is the same quadratic shape as EMAIL's. This one was the real cost.
  /[A-Za-z0-9._%+-]{1,64}\s+[Aa][Tt]\s+[A-Za-z0-9-]{2,255}\s+[Dd][Oo][Tt]\s+[A-Za-z]{2,24}\b/.test(s);
const RULE_URL = (s) => {
  for (const re of [HOST_AFTER_SCHEME, HOST_PROTOCOL_REL, HOST_WWW, HOST_IN_PROSE]) {
    for (const m of s.matchAll(re)) if (!hostAllowed(m[1] === undefined ? m[0] : m[1])) return true;
  }
  return false;
};
// PREFIX ALLOWLIST, separator REQUIRED. Matches Intercom/Zendesk reality; every other
// PREFIX-1234 shape is permanently somebody else's problem.
const RULE_TICKET_REF = (s) => /\b(?:CONV|INC|ZD|TICKET|CASE)[-_]\d{3,}\b/.test(s);
const DIGIT_RUN_RE = /\+?\d[\d\s().-]{5,}\d/g; // /g — matchAll() only, never .test()
// ponytail: dates and semver look phone-shaped; whitelist those two shapes instead of writing a
// real phone parser. Ceiling: an exotic date format could still trip it — the safe direction.
const NOT_A_PHONE = [/^\d{4}-\d{2}-\d{2}$/, /^\d+\.\d+(\.\d+)*$/];
const RULE_DIGIT_RUN = (s) => {
  for (const m of s.matchAll(DIGIT_RUN_RE)) {
    const hit = m[0].trim();
    if (NOT_A_PHONE.some((re) => re.test(hit))) continue;
    if ((hit.match(/\d/g) || []).length >= 7) return true;
  }
  return false;
};

// ONE LINE PER RULE. worker/mutate.mjs disables a rule by deleting its line (§6.5), so keep
// each entry on its own line and keep the two files identical.
const PII_RULES = [
  ['EMAIL', RULE_EMAIL],
  ['EMAIL_NO_TLD', RULE_EMAIL_NO_TLD],
  ['EMAIL_OBFUSCATED', RULE_EMAIL_OBFUSCATED],
  ['URL', RULE_URL],
  ['TICKET_REF', RULE_TICKET_REF],
  ['DIGIT_RUN', RULE_DIGIT_RUN],
];

// Returns the RULE NAME that tripped, or null. NEVER returns the offending value: the result
// ends up in a log line (§6.4) and in a 400 body.
export function piiRule(s) {
  if (typeof s !== 'string' || s === '') return null;
  for (const [name, test] of PII_RULES) if (test(s)) return name;
  return null;
}

export const PII_RULE_NAMES = PII_RULES.map(([n]) => n);
export const PII_LIMITS = LIMITS;
export const PII_PUBLIC_LABELS = [...PUBLIC_LABELS];
// ===== END SHARED §6.1 BLOCK =====

/** @param {unknown} v @returns {v is string} */
const isStr = (v) => typeof v === 'string';

/**
 * Validate the POST /api/ingest/patterns body (CONTRACT §3) including the full
 * §6.1 v4 PII guard and the §6.6 input bounds. Any string anywhere in the body that trips any
 * rule rejects the whole request with a 400; anything over a §6.6 cap is a 400 too, never a
 * truncation. The body is validated in full before the caller writes anything.
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function validateIngest(body) {
  const bad = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');
  const b = /** @type {Record<string, unknown>} */ (body);

  if (!isStr(b.source) || !b.source.trim()) return bad('source must be a non-empty string');
  if (b.window_days !== undefined && !Number.isFinite(b.window_days)) {
    return bad('window_days must be a number');
  }
  if (!Array.isArray(b.patterns) || b.patterns.length === 0) {
    return bad('patterns must be a non-empty array');
  }
  // §6.6 cap 2, first statement that touches the array. This one is NOT optional: every other
  // cap is per-element, so 100,000 minimal patterns passes all of them, and this loop runs
  // before the worker's top-N slice has any say.
  if (b.patterns.length > LIMITS.patterns) {
    return bad(`patterns exceeds the ${LIMITS.patterns}-entry cap (CONTRACT §6.6)`);
  }

  // Every string anywhere in the body, paired with its path, so the 400 can name the field
  // that tripped without ever echoing its content. Nothing nested may be missed here:
  // source, label, description, every question, every suggestion body.
  // ONE FIELD CLASS PER LINE — worker/mutate.mjs deletes a line to prove this self-check
  // notices (§6.5). `suggestions[].type` is deliberately absent: it is enum-constrained below,
  // so it cannot carry free text and a mutant deleting it could never be killed.
  /** @type {[string, string][]} */ const fields = [];
  fields.push(['source', b.source]);
  /** @type {any[]} */ const patterns = [];

  for (let i = 0; i < b.patterns.length; i++) {
    const p = b.patterns[i];
    const at = `patterns[${i}]`;
    if (!p || typeof p !== 'object' || Array.isArray(p)) return bad(`${at} must be an object`);

    if (!isStr(p.label) || !p.label.trim()) return bad(`${at}.label must be a non-empty string`);
    if (p.label.length > LIMITS.label) return bad(`${at}.label exceeds ${LIMITS.label} chars`);
    const description = p.description === undefined ? '' : p.description;
    if (!isStr(description)) return bad(`${at}.description must be a string`);
    if (description.length > LIMITS.description) {
      return bad(`${at}.description exceeds the ${LIMITS.description}-char cap (CONTRACT §6.6)`);
    }
    const ticket_count = p.ticket_count === undefined ? 0 : p.ticket_count;
    if (!Number.isInteger(ticket_count) || ticket_count < 0) {
      return bad(`${at}.ticket_count must be a non-negative integer`);
    }
    // §2 declares the column integer/int4. An over-range value raises at INSERT, hits the
    // catch and rolls back the transaction — discarding the ENTIRE batch, not the one pattern.
    if (ticket_count > LIMITS.ticketCount) {
      return bad(`${at}.ticket_count exceeds ${LIMITS.ticketCount} (int4, CONTRACT §6.6)`);
    }

    const questions = p.questions === undefined ? [] : p.questions;
    if (!Array.isArray(questions)) return bad(`${at}.questions must be an array`);
    if (questions.length > LIMITS.questions) {
      return bad(`${at}.questions exceeds the ${LIMITS.questions}-entry cap (CONTRACT §6.6)`);
    }
    for (let j = 0; j < questions.length; j++) {
      if (!isStr(questions[j]) || !questions[j].trim()) {
        return bad(`${at}.questions[${j}] must be a non-empty string`);
      }
      if (questions[j].length > LIMITS.question) {
        return bad(`${at}.questions[${j}] exceeds the ${LIMITS.question}-char cap (CONTRACT §6.6)`);
      }
    }

    const rawSuggestions = p.suggestions === undefined ? [] : p.suggestions;
    if (!Array.isArray(rawSuggestions)) return bad(`${at}.suggestions must be an array`);
    if (rawSuggestions.length > LIMITS.suggestions) {
      return bad(`${at}.suggestions exceeds the ${LIMITS.suggestions}-entry cap (CONTRACT §6.6)`);
    }
    /** @type {any[]} */ const suggestions = [];
    for (let j = 0; j < rawSuggestions.length; j++) {
      const s = rawSuggestions[j];
      const sat = `${at}.suggestions[${j}]`;
      if (!s || typeof s !== 'object' || Array.isArray(s)) return bad(`${sat} must be an object`);
      if (!isStr(s.type) || !['update', 'create', 'media'].includes(s.type)) {
        return bad(`${sat}.type must be one of update|create|media`);
      }
      if (!isStr(s.body) || !s.body.trim()) return bad(`${sat}.body must be a non-empty string`);
      if (s.body.length > LIMITS.suggestionBody) {
        return bad(`${sat}.body exceeds the ${LIMITS.suggestionBody}-char cap (CONTRACT §6.6)`);
      }
      // Optional: which existing article this is about, by external_id from GET /api/articles.
      // An unknown id is NOT an error — the route resolves what it can and leaves the rest null,
      // because a model naming a stale id should cost one link, not the whole batch.
      // It is a §6.1-guarded field like any other: an external_id is a URL for two of the three
      // platforms, so it goes through the same scrub rather than around it.
      let articleRef = null;
      if (s.article_external_id !== undefined && s.article_external_id !== null) {
        if (!isStr(s.article_external_id)) return bad(`${sat}.article_external_id must be a string`);
        if (s.article_external_id.length > 500) {
          return bad(`${sat}.article_external_id exceeds the 500-char cap (CONTRACT §6.6)`);
        }
        articleRef = s.article_external_id;
      }
      suggestions.push({ type: s.type, body: s.body, article_external_id: articleRef });
    }

    fields.push([`${at}.label`, p.label]);
    fields.push([`${at}.description`, description]);
    for (let j = 0; j < questions.length; j++) fields.push([`${at}.questions[${j}]`, questions[j]]);
    for (let j = 0; j < suggestions.length; j++) {
      fields.push([`${at}.suggestions[${j}].body`, suggestions[j].body]);
      if (suggestions[j].article_external_id !== null) {
        fields.push([`${at}.suggestions[${j}].article_external_id`, suggestions[j].article_external_id]);
      }
    }
    patterns.push({
      label: p.label,
      description,
      ticket_count,
      questions,
      suggestions,
    });
  }

  // §6.1: any string tripping any rule rejects the WHOLE request. Never partially accept,
  // never redact-and-keep — a partially scrubbed sentence is a false sense of safety.
  // The error names the rule and the field. It never echoes the offending value.
  for (const [path, value] of fields) {
    const rule = piiRule(value);
    if (rule) return bad(`PII guard: ${path} trips rule ${rule} (CONTRACT §6.1)`);
  }

  // Optional run metadata (CONTRACT §3): numbers and a model name, so cost is observable rather
  // than estimated. Whitelist-rebuilt like everything else — a model cannot smuggle extra keys in
  // here, and `model` is the only string, so it is guarded like any other.
  let run = null;
  if (b.run !== undefined && b.run !== null) {
    if (typeof b.run !== 'object' || Array.isArray(b.run)) return bad('run must be an object');
    const num = (v, name) => {
      if (v === undefined || v === null) return null;
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return bad(`run.${name} must be a non-negative number`);
      return v;
    };
    const cost = num(b.run.cost_usd, 'cost_usd');
    if (cost && cost.ok === false) return cost;
    const inTok = num(b.run.input_tokens, 'input_tokens');
    if (inTok && inTok.ok === false) return inTok;
    const outTok = num(b.run.output_tokens, 'output_tokens');
    if (outTok && outTok.ok === false) return outTok;
    const dur = num(b.run.duration_ms, 'duration_ms');
    if (dur && dur.ok === false) return dur;
    if (b.run.model !== undefined && b.run.model !== null) {
      if (!isStr(b.run.model) || b.run.model.length > 120) return bad('run.model must be a string under 120 chars');
      const rule = piiRule(b.run.model);
      if (rule) return bad(`PII guard: run.model trips rule ${rule} (CONTRACT §6.1)`);
    }
    run = {
      cost_usd: cost,
      input_tokens: inTok,
      output_tokens: outTok,
      duration_ms: dur,
      model: isStr(b.run.model) ? b.run.model : null,
      grounded: b.run.grounded === true,
    };
  }

  return {
    ok: true,
    value: {
      source: b.source,
      window_days: b.window_days === undefined ? 30 : b.window_days,
      patterns,
      run,
    },
  };
}

/**
 * Validate POST /api/suggestions (CONTRACT §3) — standalone, article-linked suggestions.
 *
 * B1 produces suggestions that are NOT pattern-shaped: they come from a code change, not from a
 * cluster of tickets, so there is no label, description or questionnaire to hang them on. Rather
 * than bend the ingest endpoint into two shapes, this is its own narrow one.
 *
 * Same §6.1 guard as everything else, and the same all-or-nothing rule: one bad string rejects the
 * whole request. Partial acceptance would leave the caller unable to say what was stored.
 *
 * @param {unknown} body
 * @returns {{ ok: true, value: any } | { ok: false, error: string }}
 */
export function validateSuggestions(body) {
  const bad = (error) => ({ ok: false, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');
  const b = /** @type {any} */ (body);

  if (!Array.isArray(b.suggestions)) return bad('suggestions must be an array');
  if (b.suggestions.length === 0) return bad('suggestions must not be empty');
  // Same reasoning as the patterns[] cap: every other bound here is per-element, so an unbounded
  // array passes all of them (CONTRACT §6.6).
  if (b.suggestions.length > 100) return bad('suggestions exceeds the 100-entry cap (CONTRACT §6.6)');

  /** @type {[string, string][]} */ const fields = [];
  /** @type {any[]} */ const suggestions = [];

  for (let i = 0; i < b.suggestions.length; i++) {
    const s = b.suggestions[i];
    const at = `suggestions[${i}]`;
    if (!s || typeof s !== 'object' || Array.isArray(s)) return bad(`${at} must be an object`);
    if (!isStr(s.type) || !['update', 'create', 'media'].includes(s.type)) {
      return bad(`${at}.type must be one of update|create|media`);
    }
    if (!isStr(s.body) || !s.body.trim()) return bad(`${at}.body must be a non-empty string`);
    if (s.body.length > LIMITS.suggestionBody) {
      return bad(`${at}.body exceeds the ${LIMITS.suggestionBody}-char cap (CONTRACT §6.6)`);
    }
    let ref = null;
    if (s.article_external_id !== undefined && s.article_external_id !== null) {
      if (!isStr(s.article_external_id)) return bad(`${at}.article_external_id must be a string`);
      if (s.article_external_id.length > 500) return bad(`${at}.article_external_id exceeds the 500-char cap`);
      ref = s.article_external_id;
    }
    // A `source` label so the dashboard can say where a suggestion came from — B1 or the miner.
    let source = 'staleness';
    if (s.source !== undefined && s.source !== null) {
      if (!isStr(s.source) || s.source.length > 40) return bad(`${at}.source must be a string under 40 chars`);
      source = s.source;
    }
    suggestions.push({ type: s.type, body: s.body, article_external_id: ref, source });
    fields.push([`${at}.body`, s.body]);
    if (ref !== null) fields.push([`${at}.article_external_id`, ref]);
    fields.push([`${at}.source`, source]);
  }

  for (const [path, value] of fields) {
    const rule = piiRule(value);
    if (rule) return bad(`PII guard: ${path} trips rule ${rule} (CONTRACT §6.1)`);
  }

  return { ok: true, value: { suggestions } };
}
