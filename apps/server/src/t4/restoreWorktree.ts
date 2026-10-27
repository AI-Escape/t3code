/**
 * t4 fork: a thread whose worktree is gone always resumes.
 *
 * t4's reaper removes a clean worktree once its thread has been settled 48 h
 * (and archived or deleted threads' at once), relying on T3 to recreate it
 * from the branch when the thread is used again. Upstream recreates it at
 * turn start, but only from a branch that still exists and without the
 * project's setup script - and, before the fork accepted flat paths, never
 * for t4's `/t3/worktrees/<issue id>` at all, so such a thread answered every
 * message with "workspace folder no longer exists" (zappy, 2026-10-27).
 *
 * Here: the branch is checked out again if it exists (locally, or as a single
 * remote's branch, which git tracks); otherwise a fresh branch of that name
 * starts from origin's default branch (`origin/HEAD`, else the project's
 * HEAD). Then the project's setup script runs, as on a new worktree - t4's
 * instructions and skills. It runs as a plain process, not in a T3 terminal:
 * turn start holds the worktree's workspace lease, which opening a terminal
 * there waits for (that deadlocked the first version of this).
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

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";

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

export const restoreWorktree = Effect.fn("t4.restoreWorktree")(function* (input: {
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly settings: ServerSettings | undefined;
  readonly threadId: string;
  readonly project: {
    readonly id: ProjectId;
    readonly workspaceRoot: string;
    readonly scripts: ReadonlyArray<ProjectScript> | undefined;
  };
  readonly worktreePath: string;
  readonly branch: string;
}) {
  const cwd = input.project.workspaceRoot;
  const path = input.worktreePath;
  yield* input.gitWorkflow.pruneWorktrees({ cwd });
  yield* input.gitWorkflow.createWorktree({ cwd, refName: input.branch, path }).pipe(
    Effect.catch(() =>
      Effect.logWarning("t4.restore-worktree.new-branch", {
        threadId: input.threadId,
        branch: input.branch,
      }).pipe(
        Effect.andThen(
          input.gitWorkflow.createWorktree({
            cwd,
            refName: "origin/HEAD",
            newRefName: input.branch,
            path,
          }),
        ),
        Effect.catch(() =>
          input.gitWorkflow.createWorktree({
            cwd,
            refName: "HEAD",
            newRefName: input.branch,
            path,
          }),
        ),
      ),
    ),
  );
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
