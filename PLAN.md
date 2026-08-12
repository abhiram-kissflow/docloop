# Docloop — auto-updating helpdocs app for Kissflow (blueprint + MVP slice)

> **Handover note:** This plan is self-contained — written for an executing agent with no prior conversation context. Read fully before starting. Ask the user (Abhiram) only where a step says USER ACTION.

## 1. Context & problem

Kissflow's documentation team (Abhiram leads it) faces the classic doc-rot problem that Pageloop.ai (https://docs.pageloop.ai/) commercializes: product changes faster than docs; nobody notices until support tickets pile up.

Pageloop's loop (researched from their docs): record product flows → AI drafts help articles → monitor product changes → suggest updates → human reviews and applies → audits catch broken links/conflicts. Integrations: Zendesk/Intercom/Freshdesk, Jira/Linear, Slack. **Pageloop only sees the UI.** We can beat that: we have codebase access, ticket data, and local media tooling.

Kissflow specifics (verified facts):
- **Docs are NOT hosted on Intercom.** Intercom holds **support tickets/conversations** only. (Doc platform TBD — open question §8.)
- Product repos: `kf-xg-frontend` (frontend) + `kissflow-xg` (backend).
- A merged cross-repo semantic graph already exists: `~/.graphify-data/kissflow-cross-repo/graphify-out/graph.json` (nodes tagged by `repo`). Refresh script: `~/.graphify-data/scripts/refresh-kissflow-graphs.sh` (AST-only, no LLM cost — ask user before running).
- `codebase-memory-mcp` provides structural code index (search_graph, trace_path, get_code_snippet).
- Intercom MCP connected in Claude Code (`mcp__claude_ai_Intercom__search_conversations` etc.); Intercom REST API available for the worker (token: USER ACTION to provide).
- Local media stack on the Mac: Playwright MCP (browser capture), HyperFrames CLI (HTML→video), ffmpeg, ElevenLabs MCP (TTS/music), `gen-image` CLI.
- Claude Code skills available for drafting: `doc-coauthoring`, `eos` (Elements of Style review), `doc-prep` (outline from graphify + fact-check via codebase-memory-mcp), `kf-whatsnew-writer`, `tech-writing`.

## 2. User requirements (as stated)

Three workstreams:
- **A. Ticket-signal mining:** classify most-sought-after support patterns from Intercom conversations → convert each into a **questionnaire** (the concrete questions users ask) → use questionnaires to drive doc updates.
- **B. Staleness detection:** check existing docs against (i) the codebase — frontend + backend — and (ii) the actual live UI.
- **C. New-doc creation:** generate documentation when new features launch.

Cross-cutting requirements:
- Must be an **app** connecting to GitHub, Intercom, and third-party tools via **webhooks and APIs**.
- Article drafting must use the **doc-coauthoring** and **eos** skills.
- Auto-generate **videos/GIFs** when a doc needs them: Playwright MCP (capture) + HyperFrames + ffmpeg (compose) + ElevenLabs (narration).
- Human review gates all publishes — never auto-publish.

Decisions already made with user:
- **Form factor: Vercel receiver + Mac worker.** Vercel app receives webhooks and hosts dashboard/queue; the Mac runs a worker doing all heavy lifting (Claude Code skills, Playwright, HyperFrames, ffmpeg, ElevenLabs).
- **Scope this round: blueprint + MVP slice** (Workstream A vertical). Everything else designed in the blueprint, built later.

## 3. Architecture

```
GitHub ──webhook──▶ ┌────────────────────┐        ┌──────────────────────────┐
Intercom ─API/hook▶ │  Vercel app (web/) │◀─poll──│  Mac worker (worker/)     │
3rd party ─webhook▶ │  Next.js + Postgres│──jobs─▶│  Node + launchd           │
                    │  dashboard + queue │◀─post──│  claude -p (skills),      │
                    └────────────────────┘ results│  Playwright, HyperFrames, │
                                                  │  ffmpeg, ElevenLabs       │
                                                  └──────────────────────────┘
```

- **Vercel app** (`~/docloop/web`, Next.js App Router, Node runtime — NOT edge):
  - `/api/hooks/github` — HMAC-verified (X-Hub-Signature-256), stores push/release/PR events.
  - `/api/hooks/intercom` — endpoint exists from day 1; live wiring deferred (needs Intercom developer-app setup).
  - `/api/hooks/generic` — bearer-token-protected catch-all for third-party tools.
  - `/api/jobs` — worker pulls pending jobs (auth: `WORKER_API_KEY` bearer). `/api/results` — worker posts outputs.
  - Dashboard (single page to start): pattern leaderboard, questionnaire per pattern, suggestion queue with approve/dismiss.
  - **Postgres via Vercel Marketplace** — executing agent MUST load the `vercel:marketplace` skill before provisioning; do not hand-pick a provider.
- **Mac worker** (`~/docloop/worker`, single Node script + launchd plist):
  - Poll loop: fetch jobs → execute → post results.
  - Classification/drafting via headless Claude: `claude -p "<prompt>"` (skills accessible).
  - Media jobs (later phase): Playwright records flow → frames/clips → HyperFrames or ffmpeg compose → GIF/MP4; ElevenLabs narration for video.
- **Shared index** (the keystone): table mapping `article ↔ features/routes/components` (sourced from the graphify graph + manual seeding). All three workstreams key off it. Suggestion priority = ticket volume × staleness score.

### Data model (Postgres)
- `events` (id, source [github|intercom|generic], type, payload jsonb, received_at)
- `patterns` (id, label, description, question_count, ticket_count, last_seen)
- `questionnaires` (id, pattern_id, questions jsonb, created_at)
- `articles` (id, external_id, title, url, platform, features jsonb)  — the doc↔code index
- `suggestions` (id, type [update|create|media], pattern_id?, article_id?, body, status [pending|approved|dismissed], created_at)
- `jobs` (id, kind, payload jsonb, status [pending|running|done|failed], result jsonb)

## 4. Workstream designs (full detail in BLUEPRINT.md, summarized here)

- **A — demand side:** worker pulls recent Intercom conversations (API poll for MVP; webhook later) → `claude -p` clusters into intents → ranked patterns → per top pattern, generate questionnaire → run questionnaire against `articles` index (does a doc answer each question? findable? current?) → gaps become `suggestions`.
- **B — supply side:** (i) *codebase*: git-push webhook → map changed files to features via graphify graph → find impacted articles via index → staleness job → `doc-prep`-style fact-check of article claims → suggestion with diff summary. (ii) *UI*: scripted Playwright walkthrough replays documented steps, screenshots compared against article screenshots/step text → mismatch = suggestion.
- **C — creation:** GitHub release/feature-flag signal → `doc-prep` outline from graph → draft via `doc-coauthoring` conventions → `eos` style pass → suggestion of type `create` → writer reviews. `kf-whatsnew-writer` for release-note entries.
- **Media pipeline:** when an approved suggestion flags "needs GIF/video": job → Mac worker → Playwright records the flow in the real product → GIF via ffmpeg (short loop) or narrated MP4 via HyperFrames + ElevenLabs → asset attached to suggestion.

## 5. Deliverables THIS round

1. **`~/docloop/BLUEPRINT.md`** — the full design: everything in §1–§4 expanded, plus integration matrix, phasing roadmap (A → B-codebase → B-UI → C → media), risks, open questions (§8). This is the doc the team reads.
2. **MVP slice (working code):**
   - `web/`: Next.js scaffold, Postgres provisioned (marketplace skill), schema above, GitHub webhook route (HMAC-verified, live), generic webhook route, jobs/results API, dashboard page.
   - `worker/`: Intercom API poll → classify via `claude -p` → aggregate patterns → questionnaires for top 5 → post suggestions. launchd plist (e.g. every 6h) but also runnable manually.
   - Deployed to Vercel preview; one real end-to-end run on recent Intercom data.
3. **Deferred explicitly** (designed, not built): staleness sweeps, UI diffing, drafting runs, media generation, Intercom/third-party live webhooks, publish-back integrations.

## 6. Execution steps

1. `mkdir ~/docloop`; write `BLUEPRINT.md` first (it's the contract).
2. Scaffold `web/` (Next.js, TypeScript, App Router). Load `vercel:marketplace` skill → provision Postgres → apply schema (plain SQL migration file, no ORM — ponytail).
3. Implement API routes + dashboard (single page, server components, no UI framework beyond Tailwind/shadcn if scaffold includes it).
4. Deploy preview via `vercel` CLI (install if missing: `npm i -g vercel`). Set env: `DATABASE_URL`, `GITHUB_WEBHOOK_SECRET`, `GENERIC_HOOK_TOKEN`, `WORKER_API_KEY`.
5. USER ACTION: Intercom access token for the worker (or reuse existing Google-workspace-independent Intercom credentials); GitHub webhook creation on the target repo(s) (user must confirm which repos and has admin rights).
6. Build `worker/` (one `index.mjs`, no framework): Intercom fetch (last 30 days conversations, paginated) → classification prompt → patterns/questionnaires → POST to web API. Write launchd plist to `~/Library/LaunchAgents/com.docloop.worker.plist` but **ask user before loading it**.
7. End-to-end run + verification (§7).

## 7. Verification

- `curl` a signed GitHub-style payload → 200; event row visible in DB and dashboard.
- Wrong signature → 401.
- Worker manual run against real Intercom data → patterns + questionnaires + suggestions render on the deployed dashboard.
- **PII guard (hard rule):** stored pattern/questionnaire text must be pattern-level only — no customer names, emails, company names, or verbatim ticket quotes. Spot-check DB rows.
- BLUEPRINT.md covers all three workstreams + media pipeline + integration matrix + phasing.

## 8. Open questions (park in BLUEPRINT.md, don't block MVP)

- Which platform hosts the docs today (affects publish-back integration + `articles.external_id`).
- Intercom developer-app/webhook setup — who owns the Intercom workspace admin.
- Which GitHub org/repos get webhooks; monorepo event noise filtering.
- Review-queue ownership within the TW team (four writers; individual roles not yet assigned).
- Whether docs' existing screenshots are retrievable programmatically (needed for UI-diff phase).

## 9. Guardrails for the executing agent

- Never auto-publish to any doc platform; suggestions end at human review.
- Customer PII never leaves Intercom into stored text or any external-facing artifact.
- Ask user before: loading launchd plist, running graph refresh script, creating GitHub webhooks, any Intercom write operation.
- Ponytail discipline: no ORM, no auth framework (bearer tokens suffice), no job-queue library (Postgres table is the queue), single dashboard page until real usage demands more.
