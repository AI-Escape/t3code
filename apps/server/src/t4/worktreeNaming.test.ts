import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { uniqueWorktreePath, worktreeDirName } from "./worktreeNaming.ts";

describe("t4 worktree naming", () => {
  it("names a worktree by the issue id its branch carries, else a slug", () => {
    assert.equal(worktreeDirName("feature/usa-1299-strict-backend-type-checking"), "usa-1299");
    assert.equal(worktreeDirName("Supermaxman/USA-42-fix"), "usa-42");
    assert.equal(
      worktreeDirName("t3/Some Long Task Name That Goes On-ab12"),
      "some-long-task-name-that",
    );
  });

  it.effect("adds -2, -3 when the directory is taken", () =>
    Effect.gen(function* () {
      const taken = new Set(["/t3/worktrees/usa-7", "/t3/worktrees/usa-7-2"]);
      const path = yield* uniqueWorktreePath(
        "/t3/worktrees",
        "feature/usa-7-x",
        (...parts) => parts.join("/"),
        (candidate) => Effect.succeed(taken.has(candidate)),
      );
      assert.equal(path, "/t3/worktrees/usa-7-3");
    }),
  );
});
