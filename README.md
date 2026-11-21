<p align="center">
  <a href="https://t3.codes">
    <img src="./assets/prod/t3-black-web-icon-192x192.png" width="80" height="80" alt="T3 Code logo" />
  </a>
</p>

<h1 align="center">T3 Code</h1>

<p align="center">The open-source control plane for coding agents.</p>

## This fork (AI-Escape, branch `t4`)

This is T3 Code v0.1.11 (Orchestrator V2) with the session tooling of
[t4](https://github.com/AI-Escape/t4) built in. t4 runs one isolated T3 server
per client, and its dashboard, instructions and container layout live in
that repo. Apart from this section, the README is upstream's. The full design
and the reasons behind it are in [`docs/t4/DESIGN.md`](docs/t4/DESIGN.md).

**Keeping in sync:** upstream (`pingdotgg/t3code`) release tags, not its
`main`, merge into `t4`, and `main` is kept equal to `t4`. t4's image pins a
commit of this branch (`T3_FORK_REF`). Fork code lives in
`apps/server/src/t4/` where it can; every edit to an upstream file is marked
with a `t4 fork:` comment, so `grep -rn "t4 fork:"` lists the merge surface.
The server reports its version as `<upstream release>-t4.<commit>`.

### Added

- **Handoffs and an obligation ledger between threads.** The new MCP tools
  `t3_handoff` (done / ask / fyi, explicit ledger effects), `t3_owed` and
  `t3_decisions` (the user's past answers to ask-user questions).
- **Release managers.** One per project: routed to by `t3_handoff`, created
  on first use, pinned, always run on `releaseManager.model`, and never
  settle.
- **Linked issues (Linear).** `link_issue`, `unlink_issue` and
  `list_thread_issues`, stored on the thread like linked PRs. The open
  thread that links an issue owns it, and launches refuse an owned issue
  unless forced.
- **Wakes.** Scheduled tasks gain one-shot (`at`, `in`) and `cron` schedules,
  plus a `threadId` target for waking another thread, under t4's limits:
  8 pending per thread, 30 days out at most, intervals of 5 minutes or more.
- **Stall recovery.** A turn silent for 15 min is interrupted and restarted
  with a note; a second stall within 6 h is stopped and pushed to the
  operator.
- **Operator HTTP API** under `/api/t4` for the t4 dashboard and scripts:
  - reads: `state`, `pending`, `archived`;
  - writes: `launch`, `resume-limited`, `threads/:id/{message,restore,delete}`.
- **Its own state** in `<userdata>/t4.sqlite`, with its own migrations.
  T3's `statev2.sqlite` is untouched. On first start it imports the old
  thread tools' JSON state once.

### Changed

- **`t3_thread_send`:** messages carry the sender's header. When a message
  closes an unanswered question or cancels a running tool call, it says so.
- **`t3_thread_organize` settle:**
  - refused for release managers, and while the thread owes anything;
  - retires the worktree's dev stack;
  - a later message cancels a pending settle.
- **`t3_thread_launch` / `create_threads`:**
  - a live-thread guard and a parent→child ledger entry with a spawn footer;
  - model presets and linked issues;
  - a launch that names no model gets the client's `defaultModelSelection`,
    not the launching thread's model.
- **`t3_thread_list` / `t3_thread_read`:** each thread's ledger standing,
  release-manager flag and linked issues.
- **Worktree naming:** `T4_WORKTREE_NAMING=issueId` gives short, flat
  `<worktrees>/<issue id or slug>` directories and keeps the full branch name.
- **Orchestration instructions:** the Claude prompt append and Codex
  developer instructions are rewritten to teach this flow.
- **Claude adapter:**
  - a `--settings` launch arg is merged under T3's own settings; upstream
    dropped it;
  - an ask-user question or approval whose tool call was aborted, for example
    by a steered message, is cancelled; upstream left it pending.
- **Codex:** `T4_CODEX_DEFAULT_REASONING_EFFORT` sets the effort the model
  picker pre-selects; upstream uses the catalog default, `low` for some
  models.
- **Scheduled-task UI (web and mobile):** shows the one-shot and cron
  schedules that agents create.

### Configuration

| Variable                            | Purpose                                                                                                                               |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `T4_SERVER_CONFIG`                  | JSON file: release-manager title and model, worktree naming, launch presets, stall recovery, legacy state dir, dev-retire script glob |
| `T4_WORKTREE_NAMING`                | `issueId` (t4) or `branch` (upstream)                                                                                                 |
| `T4_CODEX_DEFAULT_REASONING_EFFORT` | Codex effort the picker pre-selects                                                                                                   |
| `T4_LABEL`, `T4_UI_URL`             | Client name and dashboard link in stall pushes                                                                                        |

### Developing

Tests run in the Node 26 build container: `./.t4-test.sh <paths>` (the helper
is local and gitignored; it installs the pnpm `packageManager` pins, since Node
26 has no corepack). Typecheck everything from the root:
`./.t4-test.sh --cmd "cd /src && pnpm run typecheck"`. Format with
`pnpm exec vp fmt <files>` before committing. Browser tests need Chromium,
which that container lacks.

---

<p align="center">
  <a href="https://t3.codes/download"><strong>Download</strong></a> ·
  <a href="https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824">iOS</a> ·
  <a href="https://play.google.com/store/apps/details?id=com.t3tools.t3code">Android</a> ·
  <a href="https://app.t3.codes">Web</a> ·
  <a href="./docs/README.md">Docs</a> ·
  <a href="https://discord.gg/jn4EGJjrvv">Discord</a>
</p>

<p align="center">
  <a href="https://t3.codes">
    <img src="./.github/readme/hero.webp" width="100%" alt="T3 Code on desktop with a finished Claude thread, next to the phone app asking to approve a command from Codex" />
  </a>
</p>

T3 Code runs the coding agents on your machine and gives them one fast interface. Start a thread at your desk, then approve the next step from your phone.

It works with Claude Code, Codex, Cursor, OpenCode, Grok Build, Antigravity, Kiro, Pi, Muse Code, fx, and any [ACP](./docs/user/providers-acp.md) agent. If an agent is set up on your computer, T3 Code can control it.

## What you get

- **Your subscriptions.** T3 Code does not resell tokens. It drives the agents you are already signed in to.
- **Every agent in one place.** Change models in the middle of a thread. Let Claude hand a task to Codex.
- **Desktop, web, and phone.** One server, and every client shows the same threads. There are apps for iOS and Android.
- **Remote ready.** Run agents on any machine. Connect over your local network, Tailscale, or [T3 Connect](./docs/user/remote-access.md).
- **Git built in.** Each thread can work in its own worktree. Review the diff, then commit, push, and open a pull request with one button.
- **Fast.** Performance is a feature here. We measure it, and we treat a dropped frame as a bug.
- **Open.** MIT licensed. If you don't like something, fork it.

## Install

### Desktop app

[Download T3 Code](https://t3.codes/download) for macOS, Windows, or Linux. You can also use a package manager:

| Platform       | Command                                                              |
| -------------- | -------------------------------------------------------------------- |
| macOS          | `brew install --cask t3-code`                                        |
| Windows        | `winget install T3Tools.T3Code` or `scoop install extras/t3code`     |
| Arch Linux     | `yay -S t3code-bin`                                                  |
| Nix            | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`         |
| Debian, Ubuntu | `.deb` from [Releases](https://github.com/pingdotgg/t3code/releases) |

### Command line

This installs the `t3` command. Run `t3` to start the server and open the web app.

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

To try it once without an install, run `npx t3@latest`.

### Phone

Get the app from the [App Store](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824) or [Google Play](https://play.google.com/store/apps/details?id=com.t3tools.t3code). Then follow [remote access](./docs/user/remote-access.md) to connect it to your computer.

### Sign in to an agent

T3 Code needs one agent that is installed and signed in. For example, install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`.

[Provider setup](./docs/user/install.md#providers) has the steps for each agent. [Install T3 Code](./docs/user/install.md) covers nightly builds, AppImage, WSL, and NixOS.

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the tool that you want.

## Documentation

- [Install and first run](./docs/user/install.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Source control](./docs/user/source-control.md)
- [Connect outside agents over MCP](./docs/user/outside-agents.md)
- [FAQ](./docs/user/faq.md)

[All docs](./docs/README.md) has the full list.

## Contributing

We have limited review capacity. Small, focused fixes are the most likely to be merged. Features need an approved discussion first.

- Read [CONTRIBUTING.md](./CONTRIBUTING.md) before you report a bug or open a pull request.
- Put feature requests in [Ideas](https://github.com/pingdotgg/t3code/discussions/categories/ideas).
- Build from source with the [development runbook](./docs/operations/development.md#first-checkout). The [architecture overview](./docs/internals/overview.md) explains how it works.
- Get help in [Discord](https://discord.gg/jn4EGJjrvv).

## License

[MIT](./LICENSE)
