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
 * instructions and skills.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as GitWorkflowService from "../git/GitWorkflowService.ts";
import type * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";

const SETUP_TIMEOUT = Duration.minutes(10);

export const restoreWorktree = Effect.fn("t4.restoreWorktree")(function* (input: {
  readonly gitWorkflow: GitWorkflowService.GitWorkflowService["Service"];
  readonly setupScripts: Option.Option<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]
  >;
  readonly threadId: string;
  readonly project: Parameters<
    ProjectSetupScriptRunner.ProjectSetupScriptRunner["Service"]["runForThread"]
  >[0]["project"] & {};
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
  if (Option.isNone(input.setupScripts)) return;
  const setup = yield* input.setupScripts.value.runForThread({
    threadId: input.threadId,
    projectId: input.project.id,
    projectCwd: cwd,
    worktreePath: path,
    project: input.project,
  });
  if (setup.status === "started" && setup.completion !== undefined && !setup.async) {
    const completion = yield* setup.completion.pipe(Effect.timeoutOption(SETUP_TIMEOUT));
    yield* Effect.logInfo("t4.restore-worktree.setup", {
      threadId: input.threadId,
      exitCode: Option.isSome(completion) ? completion.value.exitCode : "timed out",
    });
  }
});
