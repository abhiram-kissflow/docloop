# Docloop worker — Workstream A (Intercom ticket-signal mining)

> **The launchd job is NOT loaded.** This build only *writes* `com.docloop.worker.plist`.
> Nothing is scheduled until you run the `launchctl` line yourself (below). Nothing is ever
> published anywhere — the worker's only write is a POST of pattern-level text to your own API.

One `node index.mjs` invocation = one full cycle, then exit. launchd owns scheduling.

What a cycle does:

1. Shells out to `claude -p` (Claude Code CLI, headless).
2. Claude uses the **connected Intercom MCP** — not a REST token — to pull support conversations
   from the last N days, cluster them into recurring intents, write the questionnaire (the actual
   questions users ask) for the top N patterns, and propose doc actions.
3. The response is parsed defensively (bare JSON / ```fenced``` JSON / `--output-format json`
   envelope / JSON buried in prose).
4. **PII scrub runs locally** — any pattern whose label, description, questions or suggestion
   bodies contain an email address, an `@handle`, or a phone-shaped digit run is dropped, and the
   drop is logged with the field and reason. The model is told not to emit PII; this does not
   trust it.
5. Survivors are POSTed to `${DOCLOOP_API_URL}/api/ingest/patterns` (CONTRACT §3).

## Run it manually

```bash
cd /Users/abhiram/docloop/worker

# see the payload without sending anything (no env needed)
node index.mjs --dry-run

# a real cycle
export DOCLOOP_API_URL=https://your-docloop.vercel.app
export WORKER_API_KEY=...            # same value as in the Vercel project env
node index.mjs

# narrower window, more patterns
node index.mjs --days=7 --top=8
```

### Flags

| flag | default | meaning |
|---|---|---|
| `--dry-run` | off | do everything except the POST; pretty-print the payload |
| `--days=N` | `30` | conversation window in days |
| `--top=N` | `5` | how many patterns get questionnaires |
| `--skip-audit` | off | **offline testing only** — skips the CONTRACT §6.3 adversarial pass. With `--dry-run` it prints an un-audited payload behind a loud warning; without `--dry-run` it refuses to POST and exits non-zero. It is not a bypass. |
| `--help` | — | usage |

Every run makes **two** `claude -p` calls: one to mine and cluster (§5), then a second,
independent one that audits the assembled payload for person / company / tenant names and
quoted user speech (CONTRACT §6.3). The second call **fails closed** — if it errors, times out,
or returns output that cannot be parsed, nothing is POSTed and the worker exits non-zero.

### Environment

| var | required | notes |
|---|---|---|
| `DOCLOOP_API_URL` | yes (not under `--dry-run`) | base URL of the Vercel app, no trailing slash |
| `WORKER_API_KEY` | yes (not under `--dry-run`) | bearer token, must match `web/`'s |
| `CLAUDE_BIN` | no | path to the `claude` CLI; otherwise `~/.local/bin/claude`, `/opt/homebrew/bin/claude`, `/usr/local/bin/claude`, `~/.claude/local/claude` are tried in order |
| `CLAUDE_EXTRA_ARGS` | no | extra args passed through to `claude`, space separated (e.g. `--allowedTools mcp__claude_ai_Intercom__search_conversations`) |

Missing env, or a missing `claude` binary, fails immediately with a message telling you what to fix.

### Self-check

```bash
cd /Users/abhiram/docloop/worker && node verify.mjs
```

No network, no `claude` binary required. Covers JSON extraction, the PII scrub, and flag defaults.

## Scheduling (you run this, not the build)

First fill in the real values in `com.docloop.worker.plist` — `DOCLOOP_API_URL` and
`WORKER_API_KEY` are `REPLACE-ME` placeholders. Then, the one line:

```bash
cp /Users/abhiram/docloop/worker/com.docloop.worker.plist ~/Library/LaunchAgents/ && chmod 600 ~/Library/LaunchAgents/com.docloop.worker.plist && launchctl load ~/Library/LaunchAgents/com.docloop.worker.plist
```

Runs every 6 hours (`StartInterval 21600`), not at load. Logs go to
`/Users/abhiram/docloop/worker/logs/worker.{out,err}.log`.

Check / kick / unload:

```bash
launchctl list | grep com.docloop.worker              # is it registered
launchctl start com.docloop.worker                    # run one cycle now
launchctl unload ~/Library/LaunchAgents/com.docloop.worker.plist   # stop it
```

After editing the plist: `launchctl unload` then `launchctl load` again.

## Known ceilings (ponytail)

- **Headless MCP permissions.** `claude -p` may need the Intercom MCP tools pre-approved; if a
  cycle returns nothing, run the same prompt interactively once to grant tool access, or pass
  `CLAUDE_EXTRA_ARGS`.
- **No state.** No cursor, no dedupe, no retry. A failed cycle is simply lost until the next one
  6h later; repeated runs re-upsert the same pattern labels, which `/api/ingest/patterns` handles
  idempotently.
- **Secrets in the plist.** Plaintext in `~/Library/LaunchAgents` (hence the `chmod 600`).
  Upgrade path: a wrapper script pulling them from the macOS keychain.
