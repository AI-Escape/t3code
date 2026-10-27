# T3 Code, AI-Escape fork: session tooling for t4

This fork is T3 Code v0.1.0 (Orchestrator V2) with its session tooling
extended: handoffs and an obligation ledger between threads, a per-project
release-manager role, guarded settling, worktree spawning with short paths,
one-shot and cron wakes, decisions, and stall recovery. These are T3
features, exposed through T3's own MCP server, HTTP API and instructions.

t4 (`AI-Escape/t4`) used to provide them from outside (`t3agents.py`: CLIs, a
1-minute tick and JSON state files). With this fork, t4 is the dashboard,
the client instructions and skills, and isolation (per-client containers,
the Docker sidecar, ports, the reaper, test slots, the `pkill`/`gh` guards).

**Behaviour contract:** everything t4 does today keeps working exactly as it
does. Each feature below cites the `t3agents.py` function it is taken from;
that code is the spec. Every existing T3 tool stays available. A T3 tool whose
behaviour touches these features is updated to respect them; the rest are
unchanged.

## 1. MCP tools

### Extended T3 tools

| Tool                                                                                      | From                                                | Change                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `t3_thread_send`                                                                          | `cmd_msg`, `deliver`                                | Messages between threads carry the sender header `Message from thread "<title>" (<short>):`. The two delivery notes are prepended when they apply: an unanswered ask-user question ("this message is NOT their answer … ask again"), and a Claude tool call cancelled by the steer ("this message cancelled it - not the user"). Archived targets are refused. Thread-to-thread messages steer a running turn by default; `restart` is t4's `--interrupt`. A message after a pending settle cancels it unless it is a notice (see `t3_thread_organize`). Release managers receive turns on the RM model.           |
| `t3_thread_organize` (`settle`)                                                           | `cmd_settle`, `tick_settles`, `dev_footprint`       | Refused for release managers ("release managers never settle") and while the thread owes anything (lists who, voiding closed askers). Retires the worktree's dev footprint with the repo's `scripts/*dev-retire` when there is one ("no dev environment to retire" otherwise; failure is left to the reaper). Notes pending wakes. Settles when the turn ends (existing `settlesWhenTurnEnds`); a later non-notice message cancels the request and tells the thread. `archive` on an asker voids debts owed to it.                                                                                                 |
| `t3_thread_launch`                                                                        | `cmd_spawn`, `create_worktree`, `new_thread`        | `workspaceStrategy: worktree` names the directory by the worktree naming setting (§3): issue id from the branch, else a slug, `-2…` suffixes, full branch kept, started from `origin/<base>`, project setup scripts run. New: `anyway` (the live-thread guard: running or active <3 h in the project, excluding the caller and release managers, refuses unless set), `modelPreset` (named selections, e.g. the dashboard's Codex/Claude presets), full access by default. When the caller is a thread: a parent→child `spawn` ledger entry and the spawn footer (release-manager wording when the parent is one). |
| `create_threads`                                                                          | —                                                   | Same parent→child ledger entries and footers as `t3_thread_launch` when called from a thread; same live-thread guard.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `delegate_task`                                                                           | —                                                   | Unchanged behaviour. Its child threads are listed with their parent (lineage) in `t3_thread_list`; the instructions say when to delegate versus launch.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `schedule_task`, `list_scheduled_tasks`, `update_scheduled_task`, `delete_scheduled_task` | `cmd_wake`, `wake_list/cancel/adjust`, `tick_wakes` | New schedules: one-shot `{type:'at', at}` and `{type:'in', delayMs}`, and `{type:'cron', expression}` (5 fields) alongside `interval`, `fixed_time` and `webhook`. New `threadId` target (wake another thread). Thread-bound wakes: at most 8 pending per thread, one-shots at most 30 days out, intervals at least 5 minutes. A thread-bound run is delivered as `WAKE #<n> (you scheduled this <when>):` + note, with the recurring footer; archived or deleted targets drop the wake; a failed delivery retries next minute. List/update/delete give wake list/adjust/cancel.                                   |
| `t3_thread_list`                                                                          | `cmd_sessions`                                      | Each thread also reports `isReleaseManager`, `owes` and `owedBy` counts, the caller marker, and the t4 state (running / waiting-you / settled / snoozed / idle / archived). New `allProjects` option.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `t3_thread_read`                                                                          | `cmd_show`                                          | Adds the ledger entries the thread owes and is owed, and the release-manager flag.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `t3_thread_update`                                                                        | `cmd_title`                                         | Unchanged (`rename` covers it).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `t3_worktree_handoff`                                                                     | —                                                   | Uses the worktree naming setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### New T3 tools

| Tool           | From                                                      | Behaviour                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `t3_handoff`   | `cmd_handoff`, `settle_owed`, `record_handoff`, `find_rm` | Hand work over with an explicit ledger effect. Parameters: `message`, `threadId?`, `done?`, `ask?`, `fyi?`, `interrupt?`, `check?`, `includeRetired?`. Without `threadId`: to the project's release manager, always `ask` (the RM itself is refused; `fyi` refused); if none exists, create `Release manager — <project>` on the RM model, pin it, record it, and deliver intro + handoff as its first turn. With `threadId`: one of `done`/`ask`/`fyi` required, `fyi`+`ask` refused, self refused; an owner's handoff to a release manager is forced to `ask` (with the note). `done` settles every open entry from target→caller. Header `HANDOFF from "<title>" (<short>, <where>) — <labels>:`; reply footer when asking. Non-asking deliveries are recorded as notices. `ask` opens or updates the single (from, to) entry. Result: delivery mode, entries settled, "now owes you", and "you still owe them". `check` returns the release manager or none. |
| `t3_owed`      | `cmd_owed`, `requester_closed`                            | What the caller owes (or, with `all`, the whole project), oldest first; debts to a settled, archived or deleted asker are void and omitted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `t3_decisions` | `cmd_decisions`                                           | The user's answers to ask-user questions over `days` (default 14), this project or `all`, newest first; an answer that isn't an offered option is reported as a note (a standing rule).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

### Linked issues (Linear)

Threads get linked issues the way T3 already links pull requests: a stored
list on the thread, not inferred from its title or branch (today's t4
dashboard and `spawn` parse an issue id out of the title/branch).

- Thread state: `linkedIssues` — `{ provider: "linear", identifier: "USA-1234",
  url, title, linkedAt }[]`, in thread shells (`/api/orchestration/shell`),
  `t3_thread_list` and `t3_thread_read`.
- New tools, mirroring `link_pull_request` / `unlink_pull_request` /
  `list_thread_pull_requests`: `link_issue` (identifier or URL; linking an
  issue another open thread owns is refused unless `force`, naming that
  thread), `unlink_issue`, `list_thread_issues`.
- Ownership: an issue is owned by the open (not settled/archived) thread that
  links it. `t3_thread_launch` / `create_threads` take `issues` and link them
  at creation, with the same ownership refusal (the dashboard's "already
  owned" check becomes this, not a title match). `issueOwner` lookup for the
  dashboard via `GET /api/t4/state`.
- Settling or archiving a thread releases its issues (it no longer owns them);
  the links stay on the thread as history.
- Migration: on import, each V1 thread's title/branch issue id (t4's current
  rule) becomes its first linked issue, so ownership carries over.
- Linear API calls (status, fetching titles) stay in the dashboard, which
  holds the client's `LINEAR_API_KEY`; T3 stores links only.
- Instructions: link every Linear issue you take ownership of (`linear-own`),
  unlink one you hand back; `title` keeps the issue id first.

## 2. Instructions

`T3_CODE_ORCHESTRATION_INSTRUCTIONS` (Claude system-prompt append) and
`buildCodexDeveloperInstructions` are rewritten to describe the toolset above
as one model of work: hand off with an explicit ledger effect, the release
manager's role, answer what you owe before settling, settle as the last act,
spawn into a worktree vs delegate a subtask vs message a thread, wakes, PR
linking. They stay short and only cover what the tools do; t4's per-client
doctrine still arrives through `CLAUDE.local.md` / `AGENTS.override.md`.

Claude `--settings` fix: the Agent SDK passes a single `--settings`, and T3's
own settings object (`showThinkingSummaries`) overwrites the provider's
`--settings <file>` launch arg (`sdk.mjs`: `Rn.settings = this.options.settings`),
dropping `/defaults/claude-settings.json` (`attribution: false`,
`sandbox: false`). The adapter merges a `--settings` file/JSON from
`launchArgs` under T3's keys.

Claude adapter switches (environment, set in t4's compose):

- `T4_CLAUDE_QUESTIONS_AS_MESSAGES=1` — AskUserQuestion posts a
  message-mode question (as Codex asks) and tells Claude to end its turn
  with the brief as its final, verbatim message (`t4/questionsAsMessages.ts`).
- `T4_CLAUDE_DECLINE_SAFETY_CHECKS=1` — a full-access thread never shows an
  approval card. Under `bypassPermissions` Claude Code still forwards its own
  safety checks (e.g. the dangerous-rm guard on a relative glob after a
  `cd`); T3 marks them `provider_check`. They are declined at once with a
  note to redo the command in a form the check can verify - literal
  absolute paths, no `cd` before the rm (`t4/declineSafetyChecks.ts`).
  Asks from a matched ask rule still reach the user.

## 3. Settings

- `releaseManager.model` — selection release managers run on (t4: Codex
  gpt-6.1-sol, high).
- `worktreeNaming` — `branch` (upstream behaviour) or `issueId` (t4: flat
  `<worktreesDirectory>/<issue-id or slug>`). A thread whose worktree is
  gone (t4's reaper removes clean ones after 48 h settled) gets it back at
  its next turn, flat paths included: its branch is checked out again, or,
  if the branch is gone, a fresh one of that name starts from `origin/HEAD`;
  then the project's setup script runs (`t4/restoreWorktree.ts`). Upstream
  recreated only `<worktrees>/<repo>/<branch>` paths from an existing
  branch, without setup.
- `launchPresets` — named model selections for `t3_thread_launch` and the
  operator API.
- `stallRecovery` — enabled, silence minutes (15), repeat window (6 h).
- Existing settings keep their meaning (`sidebarAutoSettle*` off for t4,
  `continueThreadsAfterServerUpdate` on).

## 4. Server jobs

| Job                    | From                          | Notes                                                                                                                                            |
| ---------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Wake delivery          | `tick_wakes`                  | T3's `Scheduler`.                                                                                                                                |
| Settle cancel rule     | `tick_settles`                | On message dispatch.                                                                                                                             |
| Release-manager model  | `deliver` (`RM_MODEL`)        | Every turn delivered to a release manager by these tools runs on `releaseManager.model` within its provider.                                     |
| Stall recovery         | `tick_stalled_turns`          | 15 min silence (no output, no tool call executing, not waiting on the user) → interrupt + restart note; a second stall within 6 h → stop + push. |
| Orphaned questions     | `tick_orphan_questions`       | Ported only where V2's own restart handling of pending requests doesn't already cover it (verified first).                                       |
| Interrupted background | `tick_interrupted_background` | Same: V2 already reports background work killed by a restart; ours fills gaps only.                                                              |
| Limited-thread resume  | `cmd_resume`                  | Operator action: probe one thread, then 3 at a time 60 s apart, release managers first, skipping threads already moving.                         |

## 5. State

Fork-owned tables in their own database, `<userdata>/t4.sqlite` (T4Sql),
with their own migration ledger (`t4_sql_migrations`). T3's `statev2.sqlite`
is untouched: no upstream migration-id collisions
(`docs/internals/legacy-orchestration-migration.md`), no effect on T3's
planner statistics, and rolling back means ignoring one file. Tables:

- `t4_handoffs` (id, kind, from, from_title, to, project, summary, created_at,
  updated_at, settled_at)
- `t4_notices` (message_id, created_at), last 500
- `t4_release_managers` (project_id, thread_id)
- wakes are T3's own scheduled tasks (`once` / `cron` added); `t4_wakes`
  is unused
- `t4_settle_requests` (thread_id, requested_at)
- `t4_stalls`

One-time import on first start from `~/.config/t3-agents/state/*.json`
(handoffs, notices, release-managers, wakes, settle-requests); the files stay
as a backup.

## 6. HTTP API (dashboard and operators)

V2's HTTP API is read-only; commands go over WebSocket RPC. Added, admin
bearer token:

- `GET /api/t4/state` — ledger, release managers, issue links, wakes
  (scheduled tasks posted into threads), settle requests, per-thread facts
- `GET /api/t4/pending` — every pending question and approval, with text and
  options (the dashboard's approvals and phone pushes)
- `GET /api/t4/archived` — archived thread shells (V2's HTTP shell lists
  active threads only)
- `POST /api/t4/threads/:id/delete` — `t4 run`'s throwaway threads
- `POST /api/t4/launch` — launch with a preset and linked issues (the dashboard's Linear spawn)
- `POST /api/t4/threads/:id/restore` — unarchive / unsettle / unsnooze
- `POST /api/t4/resume-limited` — the limited-thread resume
- `POST /api/t4/threads/:id/message` — operator message

The t4 dashboard and reaper move to these plus V2's read routes, adapted to
the V2 thread shape. Dashboard features are unchanged.

## 7. What leaves t4

`t3agents.py` and its CLIs (`sessions`, `spawn`, `msg`, `handoff`, `owed`,
`wake`, `settle`, `title`, `decisions`, `resume`) and the tick are retired once
the fork provides them. t4 keeps: dashboard, `t4-setup-worktree` (client
instructions and skills into worktrees), reaper, test slots, `stack`,
`ports`, `ci`, `linear`, `pkill`/`gh` guards, container and sidecar layout.
t4's doctrine and skills are updated to name the MCP tools.

## 8. Build and deploy

- The t4 image builds this fork (pnpm 11, Node 24) and runs the server bundle
  (`apps/server` `build:bundle`, `node dist/bin.mjs`), pinned to a fork commit.
- Upstream releases merge into `t4`; fork code lives in new files where
  possible, with small marked hooks in upstream files.

## 9. Migration (from t4 on T3 0.0.45)

1. Dry run on a copy of `userdata` in an isolated container (no real
   worktrees, continue-after-restart and auto-resume off, T3 Connect
   stripped); measure the V1→V2 import of the 4.8 GB database.
2. Cutover: zero running turns, no pending questions; back up `userdata`,
   `~/.config/t3-agents`, `settings.json`, tag the current image; rename the
   stale Oct 7 `statev2.sqlite`; recreate; verify.
3. Rollback: retag the old image, restore `settings.json` and the t3-agents
   state; V1's `state.sqlite` is untouched by V2.

Known V2 migration cost: imported threads keep their transcript but not their
live provider session; each one's next turn starts a fresh session with a
~32k-character excerpt.
