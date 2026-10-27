// @effect-diagnostics nodeBuiltinImport:off - the test runs a real setup script in a temp folder.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it, vi } from "vite-plus/test";

import { restoreWorktree } from "./restoreWorktree.ts";

const projectId = ProjectId.make("project-restore");

const settingsWithSetup = (command: string) =>
  ({
    defaultProjectScripts: [],
    projectScriptOverrides: {},
    projectSettingsFolded: true,
    projectSettingsOverrides: {
      [projectId]: {
        defaultProjectScripts: [
          { id: "setup", name: "Setup", command, icon: "configure", runOnWorktreeCreate: true },
        ],
      },
    },
  }) as unknown as ServerSettings;

describe("t4 restoreWorktree", () => {
  it("runs the project's setup script in the recreated worktree, with T3's script env", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-restore-"));
    const worktreePath = Path.join(root, "usa-1445");
    const createWorktree = vi.fn((input: { path: string | null }) =>
      Effect.sync(() => {
        FS.mkdirSync(input.path!, { recursive: true });
        return {} as never;
      }),
    );
    await Effect.runPromise(
      restoreWorktree({
        gitWorkflow: { pruneWorktrees: () => Effect.void, createWorktree } as never,
        settings: settingsWithSetup(
          'printf "%s|%s" "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" > marker',
        ),
        threadId: "thread-restore",
        project: { id: projectId, workspaceRoot: root, scripts: [] },
        worktreePath,
        branch: "feature/usa-1445",
      }),
    );
    expect(FS.readFileSync(Path.join(worktreePath, "marker"), "utf8")).toBe(
      `${root}|${worktreePath}`,
    );
    FS.rmSync(root, { recursive: true, force: true });
  });

  it("checks out a fresh branch from origin's default when the branch is gone", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const createWorktree = vi.fn((input: Record<string, unknown>) => {
      calls.push(input);
      return calls.length === 1 ? Effect.fail({ _tag: "GitCommandError" } as never) : Effect.void;
    });
    await Effect.runPromise(
      restoreWorktree({
        gitWorkflow: { pruneWorktrees: () => Effect.void, createWorktree } as never,
        settings: undefined,
        threadId: "thread-restore",
        project: { id: projectId, workspaceRoot: "/repo", scripts: [] },
        worktreePath: "/t3/worktrees/usa-1445",
        branch: "feature/usa-1445",
      }),
    );
    expect(calls).toEqual([
      { cwd: "/repo", refName: "feature/usa-1445", path: "/t3/worktrees/usa-1445" },
      {
        cwd: "/repo",
        refName: "origin/HEAD",
        newRefName: "feature/usa-1445",
        path: "/t3/worktrees/usa-1445",
      },
    ]);
  });
});
