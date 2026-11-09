// @effect-diagnostics nodeBuiltinImport:off - the test runs a real setup script in a temp folder.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProjectId, type ServerSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

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
  it.live("runs the project's setup script in the recreated worktree, with T3's script env", () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t4-restore-"));
      const worktreePath = NodePath.join(root, "usa-1445");
      NodeFS.mkdirSync(worktreePath, { recursive: true });
      yield* setupRestoredWorktree({
        settings: settingsWithSetup(
          'printf "%s|%s" "$T3CODE_PROJECT_ROOT" "$T3CODE_WORKTREE_PATH" > marker',
        ),
        threadId: "thread-restore",
        project: { id: projectId, workspaceRoot: root, scripts: [] },
        worktreePath,
      });
      expect(NodeFS.readFileSync(NodePath.join(worktreePath, "marker"), "utf8")).toBe(
        `${root}|${worktreePath}`,
      );
      NodeFS.rmSync(root, { recursive: true, force: true });
    }),
  );
});
