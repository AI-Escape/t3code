import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";

import { makeWorktreeCreationLock, uniqueWorktreePath, worktreeDirName } from "./worktreeNaming.ts";

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

  it.effect("creates one worktree at a time per repository", () =>
    Effect.gen(function* () {
      const withLock = makeWorktreeCreationLock();
      const never = () => Effect.succeed(false);
      const release = yield* Deferred.make<void>();
      const started = yield* Deferred.make<void>();
      const log: Array<string> = [];
      const first = yield* withLock(
        "/repo",
        Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.andThen(Effect.sync(() => log.push("first done"))),
        ),
        never,
      ).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      const second = yield* withLock(
        "/repo",
        Effect.sync(() => log.push("second")),
        never,
      ).pipe(Effect.forkChild);
      yield* withLock(
        "/other",
        Effect.sync(() => log.push("other repo")),
        never,
      );

      const waited = yield* Fiber.join(second).pipe(
        Effect.timeoutOption("1 second"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 second");
      assert.isTrue(Option.isNone(yield* Fiber.join(waited)));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.deepEqual(log, ["other repo", "first done", "second"]);
    }),
  );

  it.effect("retries a failed creation once, and only when the failure allows it", () =>
    Effect.gen(function* () {
      const withLock = makeWorktreeCreationLock();
      let attempts = 0;
      const flaky = Effect.suspend(() =>
        ++attempts === 1 ? Effect.fail("locked" as const) : Effect.succeed("created"),
      );
      assert.equal(yield* withLock("/repo", flaky, () => Effect.succeed(true)), "created");
      assert.equal(attempts, 2);

      attempts = 0;
      const failing = Effect.failSync(() => `failed ${++attempts}`);
      const retried = yield* withLock("/repo", failing, () => Effect.succeed(true)).pipe(
        Effect.result,
      );
      assert.deepEqual(retried, Result.fail("failed 2"));

      attempts = 0;
      const lasting = yield* withLock("/repo", failing, () => Effect.succeed(false)).pipe(
        Effect.result,
      );
      assert.deepEqual(lasting, Result.fail("failed 1"));
    }),
  );
});
