// @effect-diagnostics nodeBuiltinImport:off - the test runs a real setup script in a temp folder.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { setupRestoredWorktree } from "./restoreWorktree.ts";

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

describe("t4 setupRestoredWorktree", () => {
  it("runs the project's setup script in the recreated worktree, with T3's script env", async () => {
    const root = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-restore-"));
    const worktreePath = Path.join(root, "usa-1445");
    FS.mkdirSync(worktreePath, { recursive: true });
    await Effect.runPromise(
      setupRestoredWorktree({
        settings: settingsWithSetup(
          'printf "%s|%s" "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" > marker',
        ),
        threadId: "thread-restore",
        project: { id: projectId, workspaceRoot: root, scripts: [] },
        worktreePath,
      }),
    );
    expect(FS.readFileSync(Path.join(worktreePath, "marker"), "utf8")).toBe(
      `${root}|${worktreePath}`,
    );
    FS.rmSync(root, { recursive: true, force: true });
  });
});
