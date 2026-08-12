# Docloop

Docloop watches Kissflow for change and proposes documentation work in response. Support tickets
pile up on a topic, a push touches code an article documents, a release ships something
user-visible: each of those becomes a suggestion in a review queue. You approve or dismiss every
one. **Nothing publishes automatically, ever.**

This file tells you how to run it and use it. The other documents explain why it is built the way
it is, and are listed at the bottom.

## What actually works today

Be careful with this table. Several things in `BLUEPRINT.md` read as though they exist; only the
first four rows do.

| Capability | State |
|---|---|
| **A. Ticket mining** — cluster Intercom conversations into patterns and questionnaires | **Built.** Runs on demand. |
| **B1. Code staleness** — a push raises "these articles may be affected" | **Built.** Triggered by a GitHub push webhook. |
| **C. New docs** — a release proposes the documentation it needs | **Built.** Triggered by a published release. |
| **C. What's New** — a release or feature flag drafts a public changelog entry | **Built.** Triggered by a release or a feature-flag webhook. |
| Review queue, source filters, keyboard triage | **Built.** |
| Article index with full body text (646 docs) | **Built.** Imported from an export, not fetched live. |
| B2. UI staleness — replay documented steps in a browser | Designed, not built. Needs a test account. |
| Media pipeline — GIFs and narrated video for a suggestion | Designed, not built. Needs a demo account with no customer data. |
| Publish-back — push an approved edit to the doc platform | Designed, not built. |
| Unattended scheduling (launchd) | Written, not loaded. Every run today is one you start. |
| Public deployment | Not deployed. There is no hosted database yet; it runs on this Mac only. |

## Start it

You need Postgres running and a database called `docloop`. It is already installed here as a Homebrew
service, so it starts with the machine:

```bash
brew services list | grep postgres     # expect: postgresql@17 started
```

First time only, create the database and apply the schema:

```bash
createdb docloop
psql docloop -f web/schema.sql
```

Then start the dashboard:

```bash
cd web
npm install          # first time only
npm run dev
```

It serves on <http://localhost:3000>. It asks for one shared password, which lives in
`web/.env.local` as `DASHBOARD_PASSWORD`. That file also holds `DATABASE_URL`
(`postgresql://<you>@localhost:5432/docloop`) and the webhook secrets. It is deliberately not in
git; `web/.env.example` lists the names without the values.

The dashboard runs in this terminal. Close it and the site stops.

## Work the queue

<http://localhost:3000> opens on everything pending. The tabs across the top split it by where a
suggestion came from, and every row carries the same word as a coloured badge:

| Tab | Badge | Means |
|---|---|---|
| Tickets | `ticket` | Enough support tickets asked about this |
| Code changes | `code change` | A push touched code this article documents |
| Releases | `release` | A release shipped something that may need a new article |
| What's New | `what's new` | A drafted changelog entry, ready to edit and post |

A tab showing `0` is greyed but stays visible, and its empty state tells you how many suggestions
are waiting under the other tabs, so an empty filter is never mistaken for an empty queue.

You can work the whole queue from the keyboard. Press `?` for this list at any time:

| Key | Does |
|---|---|
| `j` / `↓` | Next suggestion |
| `k` / `↑` | Previous suggestion |
| `a` | Approve the selected suggestion |
| `d` | Dismiss it |
| `g` | Go to the pattern leaderboard |
| `?` | Keyboard help |
| `Esc` | Close the help, or return to the queue |

Approving records your decision. It does not publish anything and does not notify anyone.

The right-hand pane shows the evidence for whichever row is selected: the questions real tickets
asked, the files a push changed, or the full draft of a changelog entry. Suggestion text is shown
as plain text on purpose, so markdown like `## Editable Grid` appears literally. That is not a
bug. Ticket text can contain anything a customer typed, and rendering it as HTML is how a stored
script tag would run. `CONTRACT.md` §3.1 has the reasoning.

## Make it produce suggestions

Mining is the only workstream you run directly. The other three wait for something to happen in
GitHub and then pick up the work.

### Ticket mining, on demand

```bash
cd worker
node index.mjs                    # the real run
node index.mjs --days=7 --top=8   # narrower window, more patterns
node index.mjs --dry-run          # everything except the POST — see the warning below
```

> **`--dry-run` does not mean free.** It skips the POST, nothing else. Mining still reads 30 days
> of Intercom conversations and still makes both Claude calls, so a dry run costs about what a
> real one does: the last full run was roughly **$2.21**, and about six hours of runs came to
> around $9. If you want a cheap look, use `--days=7`, not `--dry-run`.
>
> A run takes several minutes. That is normal; it is reading hundreds of conversations.

Which runs cost money, since `--dry-run` is not the answer:

| Worker | Calls a model? | `--dry-run` costs? |
|---|---|---|
| `index.mjs` (mining) | Yes, twice | Yes, nearly full price |
| `newdoc.mjs` | Yes, once | Yes |
| `whatsnew.mjs` | Yes, once | Yes |
| `staleness.mjs` | No | No. It is free either way. |

`staleness.mjs` is pure lookup: it matches changed file paths against the area map and picks
articles. Nothing about it calls a model, which is why a push is the cheapest way to see the
system work end to end.

It needs `INTERCOM_TOKEN`, `DOCLOOP_API_URL` and `WORKER_API_KEY`. They are in `worker/.env.local`;
load them into your shell first:

```bash
cd worker
set -a && . ./.env.local && set +a
```

### The other three, triggered by an event

A GitHub push or release lands on a webhook, the webhook writes a job, and a worker claims it.
Nothing happens until you run the worker, so the order is always: trigger, then run.

| Trigger | Worker to run |
|---|---|
| Push to the default branch | `node staleness.mjs` |
| Release published | `node newdoc.mjs`, then `node whatsnew.mjs` |
| Feature flag turned on | `node whatsnew.mjs` |

A published release raises two jobs, because it produces two different things: `newdoc.mjs`
proposes the help article, `whatsnew.mjs` drafts the public changelog entry. Run both.

To try it without waiting for a real event, send the webhook yourself. The feature-flag one is the
easiest, since it only needs a bearer token:

```bash
cd web
TOKEN=$(grep '^GENERIC_HOOK_TOKEN=' .env.local | cut -d= -f2- | tr -d '"')
curl -s -X POST http://localhost:3000/api/hooks/generic \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"type":"feature-flag","flag":"grid_inline_edit","name":"Editable Grid",
       "description":"Users can now edit every field directly from the table view.",
       "area":"forms-fields","enabled":true}'
```

That answers `{"ok":true,"id":...,"jobs":["12"]}`. Then `cd worker && node whatsnew.mjs` and the
draft appears under **What's New**.

A GitHub push is the same idea but the payload must be signed, which is what GitHub itself would
do:

```bash
cd web
SECRET=$(grep '^GITHUB_WEBHOOK_SECRET=' .env.local | cut -d= -f2- | tr -d '"')
BODY='{"ref":"refs/heads/main","after":"abc123",
       "repository":{"full_name":"kissflow/kissflow-xg","default_branch":"main"},
       "commits":[{"added":[],"modified":["account/common/src/helpers/color/theme.ts"],"removed":[]}]}'
SIG="sha256=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')"
curl -s -X POST http://localhost:3000/api/hooks/github \
  -H "x-github-event: push" -H "x-hub-signature-256: $SIG" \
  -H 'content-type: application/json' -d "$BODY"
```

Then `cd worker && node staleness.mjs`. That exact payload raises ten suggestions against the
forms-and-fields articles.

Every worker takes `--dry-run`, which claims the job and prints what it would send without writing
anything.

## The article index

Docloop can only say "this article may be affected" if it knows the article exists. That index is
795 articles: 646 product documentation topics with their full text, plus API and developer
reference pages.

It is imported from an export of the documentation site, not fetched live. To refresh it after a
new export:

```bash
node scripts/import-docs.mjs --file=<export.csv> | psql -d docloop
node scripts/map-doc-areas.mjs | psql -d docloop
```

The first loads titles, body text, category and last-updated date. The second tags each article
with the product areas it covers, which is what lets a changed file find the articles that
document it. Both are safe to re-run; they update in place rather than duplicating.

## Check that it is healthy

Four checks, none of which need a database, a network or an API key:

```bash
cd worker && node verify.mjs    # 56 checks
cd worker && node mutate.mjs    # 25 deliberate breakages, all must be caught
cd web    && node verify.mjs    # 31 checks
cd web    && npm run build && npx tsc --noEmit
```

They also run on GitHub for every push, so a red tick on a commit means one of these failed.

`mutate.mjs` is the unusual one and it is not ceremony. It breaks the customer-data guard on
purpose, one rule at a time, and requires the self-checks to notice. A test suite that still
passes when the thing it guards is broken is worse than no tests, because it is believed.

## Rules that do not bend

- **Nothing publishes automatically.** Every suggestion ends at a human decision.
- **Customer data from support tickets is the highest-stakes thing here.** Read `CONTRACT.md` §6
  before changing anything that stores text, and `BLUEPRINT.md` §10.1 for what the guard cannot do.
- **Ticket text is written by strangers and ends up in a model's prompt.** Treat stored text as
  data, never as instructions. `CONTRACT.md` §3.1 and `BLUEPRINT.md` §10.2.
- **Ask before**: loading the launchd schedule, creating real GitHub webhooks, running the graph
  refresh script, or any write back to Intercom.

## The other documents

| File | Answers | Read it if |
|---|---|---|
| [BLUEPRINT.md](./BLUEPRINT.md) | What are we building and why | You want to understand Docloop. **Start here.** |
| [PLAN.md](./PLAN.md) | What is being built this round | You want scope and sequencing |
| [CONTRACT.md](./CONTRACT.md) | How the two halves fit together | You are changing `web/` or `worker/` |
| [PRODUCT.md](./PRODUCT.md) | Who the dashboard is for | You are touching the interface |
| [DESIGN.md](./DESIGN.md) | What the dashboard looks like | You are touching the interface |

`CONTRACT.md` is frozen on purpose. It is the only reason `web/` and `worker/` could be built
independently without drifting apart. If an implementation disagrees with it, fix the
implementation, unless the contract is weaker than the guarantee it serves, which has happened
twice and is recorded in the amendment notes in §6.

## Layout

```
web/       Next.js App Router. Receives webhooks, stores events, serves the review dashboard.
worker/    Plain Node, zero dependencies. Does the work Vercel cannot: Claude Code, Playwright, ffmpeg.
scripts/   One-off imports and index maintenance. Each emits SQL; you pipe it to psql.
fixtures/  The taxonomy, the code and category maps, and shared test fixtures.
```

The split exists because the worker's tooling cannot run on Vercel, not because of scale.
