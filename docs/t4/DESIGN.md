# T3 Code for t4 (AI-Escape fork)

This fork is T3 Code v0.1.0 (Orchestrator V2) with t4's orchestration built
into its MCP server. t4 (`AI-Escape/t4`) runs one T3 server per client; until
now it bolted its thread tools on from outside (`t3agents.py`: CLIs, a 1-minute
tick and JSON state files). Here those become first-class MCP tools and server
jobs, and everything T3 injects that t4 doesn't use is switched off.

**Non-negotiable:** every current t4 behaviour is kept. The source of truth for
each tool below is the CLI it replaces in `t4/defaults/bin/t3agents.py`
(function names given). Native T3 features never replace a t4 flow.

## 1. What agents see

Hard requirement: Claude Code and Codex see only the tools and instructions
they should use. Nothing is shown and then blocked.

Verified against v0.1.0 (2026-10-17):

- T3 attaches its `t3-code` MCP server (≈90 tools) to every agent session
  unconditionally (`ProviderSessionManager.prepareMcpSession`; the only off
  switch, `configureMcp: false`, is a test-harness option).
- Claude gets `T3_CODE_ORCHESTRATION_INSTRUCTIONS` (~1.2k tokens:
  `delegate_task`, `t3_thread_launch`, `schedule_task` …) appended to its system
  prompt whenever that server is attached, plus `PULL_REQUEST_LINKING_INSTRUCTIONS`
  always (`ClaudeAdapterV2.makeClaudeQueryOptions`).
- Codex gets `buildCodexDeveloperInstructions` as `developer_instructions` when
  the server is attached (`CodexAdapterV2`), and T3 defines the server per thread
  on `thread/start`, which replaces any process-level `mcp_servers.t3-code`
  entry, so Codex's own `disabled_tools` cannot filter it.
- `tools/list` is global: `McpServer.toolkit` registers every tool for every
  caller (`McpHttpServer.toolkitRegistration`).

Patch:

- **Tool allowlist.** A server setting `t4.agentTools` (string list; env
  `T4_AGENT_TOOLS` overrides) names the tools registered on `/mcp`. Toolkits
  are filtered by tool name at registration, so a tool not on the list never
  appears in `tools/list` for any caller. Default in this fork: the t4 tools in
  §2 only. Native tools can be added by name later (e.g. `watch_pull_request`)
  as a deliberate choice.
- **Instructions.** T3's orchestration text, Codex developer instructions and
  the PR-linking block are not sent. A setting `t4.agentInstructionsFile`
  (optional) appends one file's text instead; empty by default, since t4's
  doctrine already reaches agents through `CLAUDE.local.md` /
  `AGENTS.override.md`. `<runtime_info>` (harness/model line) stays.
- **Claude `--settings` fix.** The Agent SDK passes a single `--settings`; T3's
  own settings object (`showThinkingSummaries`) overwrites the provider's
  `--settings <file>` launch arg (`sdk.mjs`: `Rn.settings = this.options.settings`),
  silently dropping `/defaults/claude-settings.json` (`attribution: false`,
  `sandbox: false`). The adapter now reads a `--settings` file/JSON from
  `launchArgs` and merges it under T3's keys. Upstreamable on its own.

Other providers (Cursor, Pi, OpenCode, ACP) get the same instruction switch
where they inject T3 text; t4 runs only Claude and Codex.

## 2. t4 MCP tools (agent-facing)

All on the existing `t3-code` server, authenticated by the provider-session
credential, which already identifies the calling thread. That replaces
`thread_from_agent_env` / cwd guessing / `--from`.

Thread references (`to`, `thread`) accept what `resolve()` accepts today: full
id, id prefix, short id, exact or unique-substring title; ambiguity is an error
listing candidates.

| Tool | Replaces | Parameters | Behaviour (exactly as today) |
|---|---|---|---|
| `handoff` | `cmd_handoff`, `settle_owed`, `record_handoff`, `find_rm` | `message` (required), `to?`, `done?`, `ask?`, `fyi?`, `interrupt?`, `check?`, `includeRetired?` | No `to`: hand to the project's release manager, always `ask`; the RM itself is refused ("answer owners with `handoff to`"); `fyi` without `to` refused. With `to`: one of `done`/`ask`/`fyi` required, `fyi`+`ask` refused, self refused; an owner's handoff to an RM is forced to `ask` with the note. No RM yet: create `Release manager — <project>` on `RM_MODEL`, pin it, record the RM, deliver intro + handoff as its first turn. `done` settles every open entry from target→caller. Delivery header `HANDOFF from "<title>" (<short>, <where>) — <labels>:` and the reply footer when asking. Non-asking deliveries recorded as notices. `ask` opens/updates the one (from,to) entry. Result: delivery mode, entries settled, "now owes you", "you still owe them" warning. `check`: returns the RM (id, title, state) or none. |
| `msg` | `cmd_msg`, `deliver` | `to`, `message`, `interrupt?` | Header `Message from thread "<title>" (<short>):`; self refused; archived target refused; steer into a running turn, `interrupt` stops it first; the two delivery notes (unanswered question; cancelled Claude tool call) prepended when they apply; the 2.5 s first-turn guard if V2 still needs it. |
| `owed` | `cmd_owed`, `requester_closed` | `all?` | Open entries owed by the caller (or the project with `all`), oldest first, debts to a settled/archived/gone asker omitted. |
| `settle` | `cmd_settle`, `tick_settles`, `dev_footprint` | none | Refused for release managers and while anything is owed (lists who). Retires the worktree's dev footprint via the repo's `scripts/*dev-retire` when one exists ("no dev environment to retire" otherwise; failure → reaper). Notes pending wakes. Settles when the turn ends (native `settlesWhenTurnEnds`); a later message cancels it and tells the thread, unless every later message was a notice. |
| `spawn` | `cmd_spawn`, `create_worktree`, `new_thread` | `task`, `title?`, `branch?`, `base?`, `repo?`, `model?` (selection or preset), `local?`, `anyway?` | Live-thread guard (running or active <3h, excluding caller and RMs) unless `anyway`. Worktree `/t3/worktrees/<issue-id or slug>` (short dir, full branch, `-2…` suffixes), from `origin/<base>`, project setup scripts run as T3 resolves them. Thread created full-access/default with the canonical selection. Spawn footer (RM vs ordinary parent) appended. Parent→child `spawn` ledger entry. |
| `wake` | `cmd_wake` + list/cancel/adjust, `tick_wakes` | `action` (`schedule`/`list`/`cancel`/`adjust`), `when?` (`{at}` `{in}` `{every}` `{cron}`), `note?`, `thread?`, `id?`, `all?` | Max 8 per thread; one-shots ≤30 days; `every` ≥5 min; cron 5 fields. Delivered by the server scheduler as `WAKE #n (you scheduled this …)` + recurring footer; archived/deleted targets drop the wake; failed delivery retries next minute. |
| `title` | `cmd_title` | `title` | Renames the calling thread. |
| `sessions` | `cmd_sessions`, `cmd_show` | `all?`, `project?`, `everywhere?`, `show?`, `n?` | Same rows: age, state (running / waiting-you / settled / snoozed / idle / archived), short id, where, title, `[release manager]`, `*` = caller. `show`: last n messages. |
| `decisions` | `cmd_decisions` | `days?`, `all?` | The user's answers to ask-user questions, newest first; a non-option answer shown as a note (standing rule). Reads V2's runtime-request records. |

## 3. Server jobs (replace the 1-minute tick)

| Job | Replaces | Notes |
|---|---|---|
| Wake delivery | `tick_wakes` | On T3's `Scheduler`; state in fork tables. |
| Settle cancel rule | `tick_settles` | Hooked on message dispatch: a non-notice user-role message after a pending settle cancels it and delivers the cancellation note. |
| RM model pin | `deliver` (`RM_MODEL`) | Every turn delivered to a release manager by t4 tools runs on `RM_MODEL` within its provider. |
| Orphaned questions | `tick_orphan_questions` | Verify V2 first: restarts now keep pending requests for Claude/Codex. Port only the parts V2 doesn't cover. |
| Stalled turns | `tick_stalled_turns` | Same: keep the 15-min silence rule, interrupt + restart note, second stall in 6h → stop + push. |
| Interrupted background | `tick_interrupted_background` | V2 tells agents which background work died; keep ours only if V2's note is missing or weaker. |
| Worktree setup refresh | `t4-setup-worktree --refresh` | Stays a t4 script; the server runs it every minute (or t4's entrypoint loop keeps doing so). |

## 4. State

Fork-owned tables in `statev2.sqlite`, migrated by a **separate** migration
ledger (`t4_migrations`), never T3's `effect_sql_migrations` (upstream ids
would collide; see `docs/internals/legacy-orchestration-migration.md`):

- `t4_handoffs` (id, kind, from, from_title, to, project, summary, created_at,
  updated_at, settled_at)
- `t4_notices` (message_id, created_at) — last 500 kept
- `t4_release_managers` (project_id, thread_id)
- `t4_wakes` (id, thread, thread_title, by, note, schedule_json, due, created_at, fired)
- `t4_settle_requests` (thread_id, requested_at)
- `t4_stalls`, `t4_orphan_questions` (if those jobs are ported)

One-time importer: on first start, if the tables are empty and
`~/.config/t3-agents/state/*.json` exist, import them (files left in place as a
backup).

## 5. Operator API (dashboard, scripts)

V2's HTTP API is read-only and its command path is WebSocket RPC. The fork adds
authenticated HTTP routes under `/api/t4/` (admin bearer token, the token the
dashboard already holds):

- `GET /api/t4/state` — ledger, release managers, wakes, settle requests (what
  the dashboard reads from JSON files today)
- `POST /api/t4/spawn` — Linear spawn (same as the `spawn` tool, preset model,
  no parent)
- `POST /api/t4/threads/:id/restore` — unarchive / unsettle / unsnooze
- `POST /api/t4/resume-limited` — `cmd_resume`: probe one, then 3 at a time 60 s
  apart, skip threads already moving; RMs first
- `POST /api/t4/threads/:id/message` — operator message (the CLIs' `deliver`)

The dashboard (`t4/ui/server.mjs`) and reaper move to these plus V2's read
routes (`/api/orchestration/shell`, `/threads/:id`), adapted to the V2 thread
shape. The dashboard's features stay as they are: thread list, cross-client
approvals, Archived + Restore, Resume, Linear spawn, pushes.

## 6. Build and deploy

- The t4 image builds this fork (`pnpm` 11, Node 24) and runs the server bundle
  (`apps/server` `build:bundle`, `node dist/bin.mjs`) instead of downloading the
  release binary. Pinned to a fork commit.
- Upstream releases merge into `t4` (`git fetch upstream && git merge vX`);
  fork changes stay in new files where possible, with small, marked hooks in
  upstream files to keep merges cheap.

## 7. Migration (from t4 on T3 0.0.45)

1. Dry run on a copy of `userdata` in an isolated container: no real
   worktrees, continue-after-restart and auto-resume off, T3 Connect stripped.
   Measure the V1→V2 import on the 4.8 GB database.
2. Cutover: zero running turns, no pending questions; back up `userdata`,
   `~/.config/t3-agents`, `settings.json`, and tag the current image;
   rename the stale Oct 7 `statev2.sqlite`; recreate; verify.
3. Rollback: retag the old image, restore `settings.json` and t3-agents state;
   V1's `state.sqlite` is untouched by V2.

Known migration cost (V2 design): imported threads keep their transcript but
not their live provider session; each one's next turn starts a fresh session
with a ~32k-character excerpt.
