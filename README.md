# T3 Code

T3 Code is an "agent harness control surface". It enables control of the agents on your machine with a best-in-class mobile app ([iOS](https://apps.apple.com/us/app/t3-code-remote-claude-more/id6787819824), [Android](https://play.google.com/store/apps/details?id=com.t3tools.t3code)), [web app](https://app.t3.codes) and [Electron-based desktop app](https://t3.codes).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, T3 Code can control them.

## This fork (AI-Escape, branch `t4`)

This is T3 Code v0.1.2 (Orchestrator V2) with the session tooling of
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

## "Wait, what are you selling me?"

Nothing. We built T3 Code because we wanted the best possible development experience with agents. We were inspired by existing solutions like the Codex desktop app, Conductor, Claude Desktop and Cursor Glass, but none met our bar.

We wanted something performant, remote-ready, and truly open. If we ever go the wrong direction, we want you to have everything you need to fork and build the editor that you want.

## Installation

> [!WARNING]
> T3 Code currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

Then run `t3` to start the server and open the local web app. `t3 service install` keeps it running in the background, `t3 update` moves to a newer release, and `t3 --help` has the full reference.

To try it once without installing, run `npx t3@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), or from your favorite package registry:

#### Windows (`winget`)

```bash
winget install T3Tools.T3Code
```

#### Windows (`scoop`)

```bash
scoop install extras/t3code
```

#### macOS (Homebrew)

```bash
brew install --cask t3-code
```

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/pingdotgg/t3code/releases), then:

```bash
sudo apt install ./T3-Code-*.deb
```

#### Arch Linux (AUR)

Stable:

```bash
yay -S t3code-bin
```

Nightly:

```bash
yay -S t3code-nightly-bin
```

The AUR packaging is maintained in this repository under [`packaging/aur`](./packaging/aur).

#### Nix (nixpkgs)

```bash
nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code
```

The package is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code)
and includes the desktop app (`t3code-desktop`) and the `t3` command.
See [Nix installation](./docs/user/install.md#nix-nixpkgs) for NixOS configuration and updates.

## Some notes

We are very very early in this project. Expect bugs.

We are (mostly) not accepting contributions yet. Small fixes may be considered. Big features will not be.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [FAQ](./docs/user/faq.md)
- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run T3 Code as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

## If you REALLY want to contribute still.... read this first

### Install `vp`

T3 Code uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request? Start an [Ideas discussion](https://github.com/pingdotgg/t3code/discussions/categories/ideas).

Need support? Join the [Discord](https://discord.gg/jn4EGJjrvv).
