/**
 * t4 fork: a thread whose worktree is gone always resumes.
 *
 * t4's reaper removes a clean worktree once its thread has been settled 48 h
 * (and archived or deleted threads' at once), relying on T3 to recreate it
 * when the thread is used again. Upstream recreates it at turn start
 * (ProviderTurnStartService: the branch, else a fresh one from the project's
 * branch; the fork adds origin's copy of the branch) but without the project's
 * setup script, so the thread came back without t4's instructions and skills.
 * Here the setup script runs, as on a new worktree. It runs as a plain
 * process, not in a T3 terminal: turn start holds the worktree's workspace
 * lease, which opening a terminal there waits for (that deadlocked the first
 * version of this).
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- runs the setup script outside T3 terminals, whose workspace lease turn start holds.
import * as ChildProcess from "node:child_process";

import type { ProjectId, ProjectScript, ServerSettings } from "@t3tools/contracts";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Effect from "effect/Effect";

const SETUP_TIMEOUT_MS = 10 * 60 * 1000;

const runSetupScript = (command: string, cwd: string, env: Record<string, string>) =>
  Effect.callback<{ readonly exitCode: number | null; readonly output: string }>((resume) => {
    const child = ChildProcess.execFile(
      "/bin/sh",
      ["-c", command],
      { cwd, env: { ...process.env, ...env }, timeout: SETUP_TIMEOUT_MS, maxBuffer: 4 << 20 },
      (error, stdout, stderr) => {
        const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
        resume(Effect.succeed({ exitCode: code, output: `${stdout}${stderr}`.slice(-2000) }));
      },
    );
    return Effect.sync(() => child.kill());
  });

export const setupRestoredWorktree = Effect.fn("t4.setupRestoredWorktree")(function* (input: {
  readonly settings: ServerSettings | undefined;
  readonly threadId: string;
  readonly project: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  };
  readonly worktreePath: string;
}) {
  const cwd = input.project.workspaceRoot;
  const path = input.worktreePath;
  if (input.settings === undefined) return;
  const script = setupProjectScript(
    resolveProjectScripts(input.settings, {
      id: input.project.id,
      scripts: input.project.scripts ?? [],
    }),
  );
  if (script === null) return;
  const result = yield* runSetupScript(
    script.command,
    path,
    projectScriptRuntimeEnv({ project: { cwd }, worktreePath: path }),
  );
  yield* Effect.logInfo("t4.restore-worktree.setup", {
    threadId: input.threadId,
    script: script.name,
    exitCode: result.exitCode,
    ...(result.exitCode === 0 ? {} : { output: result.output }),
  });
});
