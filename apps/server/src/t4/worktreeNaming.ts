/**
 * t4 fork: with `T4_WORKTREE_NAMING=issueId`, a new worktree is `<worktrees>/<issue id or slug>`
 * (short, since agents type absolute paths) while its branch keeps its full name. Behaviour
 * contract: `create_worktree()` in t4's `t3agents.py`.
 */
import * as Effect from "effect/Effect";

import { issueIdIn, slugOf } from "./T4Threads.ts";

export const worktreeNamingMode = (): "branch" | "issueId" =>
  process.env.T4_WORKTREE_NAMING?.trim() === "issueId" ? "issueId" : "branch";

/** The directory name for `branch`: its issue id (lowercased), else a slug of its last segment. */
export function worktreeDirName(branch: string): string {
  const issue = issueIdIn(branch);
  return issue !== null ? issue.toLowerCase() : slugOf(branch.split("/").at(-1) ?? branch, 24);
}

/** `<parent>/<name>`, or `<name>-2`, `-3`… when taken. */
export const uniqueWorktreePath = Effect.fn("t4.uniqueWorktreePath")(function* (
  parentDir: string,
  branch: string,
  join: (...parts: ReadonlyArray<string>) => string,
  exists: (path: string) => Effect.Effect<boolean>,
) {
  const name = worktreeDirName(branch);
  let candidate = join(parentDir, name);
  for (let n = 2; yield* exists(candidate); n++) candidate = join(parentDir, `${name}-${n}`);
  return candidate;
});
