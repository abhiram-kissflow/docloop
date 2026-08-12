# Docloop

Auto-updating help documentation for Kissflow. Watches the product for change — support-ticket
patterns, code commits, live UI drift — and proposes documentation work in response. A human
approves or rejects every proposal. **Nothing publishes automatically.**

Status: **MVP in progress.** Workstream A (ticket-signal mining) is being built; everything else is
designed and not yet implemented. No production deployment, no live webhooks, no Intercom
credentials in this repo.

## Which document to read

Read in this order. Each answers a different question and they do not overlap.

| File | Answers | Read it if |
|---|---|---|
| [BLUEPRINT.md](./BLUEPRINT.md) | What are we building and why | You want to understand Docloop. **Start here.** |
| [PLAN.md](./PLAN.md) | What is being built this round | You want the scope and sequencing of the current work |
| [CONTRACT.md](./CONTRACT.md) | How the two halves fit together | You are changing `web/` or `worker/` |
| [PRODUCT.md](./PRODUCT.md) | Who the dashboard is for | You are touching the interface |
| [DESIGN.md](./DESIGN.md) | What the dashboard looks like | You are touching the interface |

`CONTRACT.md` is frozen on purpose. It is the only reason `web/` and `worker/` could be built
independently without drifting. If an implementation disagrees with it, fix the implementation —
unless the contract is weaker than the guarantee it serves, which has happened twice and is
recorded in the amendment notes in §6.

## Layout

```
web/      Next.js App Router — receives webhooks, stores events, serves the review dashboard.
          Deploys to Vercel. Postgres via the Vercel marketplace.
worker/   Plain Node, zero dependencies. Runs on a Mac under launchd.
          Does the heavy lifting Vercel cannot: Claude Code skills, Playwright, ffmpeg.
fixtures/ Shared test fixtures both halves assert against (see CONTRACT §6.7).
```

The split exists because the worker's tooling cannot run on Vercel, not because of scale.

## Running it

```bash
# web — needs DATABASE_URL and friends; see web/.env.example
cd web && npm install && npm run dev

# worker — one cycle, then exits. launchd owns scheduling.
cd worker && node index.mjs --dry-run
```

Both halves carry a self-check that needs no database and no network:

```bash
cd web    && node verify.mjs
cd worker && node verify.mjs
cd worker && node mutate.mjs   # proves the self-check would fail if the guard broke
```

`mutate.mjs` is not optional ceremony. Two review passes read this code and found nothing; an
executing probe then found nine ways customer data reached a stored row and proved the self-check
passed green against a real regression. For any guarantee this project makes, the test is
execution, not inspection.

## Before you touch it

- **Never auto-publish.** Every suggestion ends at human review. This is not negotiable.
- **Customer data from support tickets is the highest-stakes thing here.** Read CONTRACT §6 in
  full before changing anything that touches stored text, and BLUEPRINT §10.1 for what the guard
  cannot do.
- **Ticket text is attacker-controlled and ends up in an agent's prompt.** BLUEPRINT §10.2 explains
  the chain. Treat stored strings as data, never as instructions.
- Ask before: loading the launchd plist, creating GitHub webhooks, running the graph refresh
  script, or any Intercom write.
