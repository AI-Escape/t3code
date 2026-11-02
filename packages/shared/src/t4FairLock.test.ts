import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";

import { makeFairLock } from "./t4FairLock.ts";

describe("t4FairLock", () => {
  it.effect("a waiter gets the lock before a looping holder takes it again", () =>
    Effect.gen(function* () {
      const lock = makeFairLock();
      const order = yield* Ref.make<ReadonlyArray<string>>([]);
      const record = (event: string) => Ref.update(order, (current) => [...current, event]);
      const looping = yield* Deferred.make<void>();

      // A loop of 20 short holds, each yielding inside like a database read.
      const loop = yield* Effect.forEach(
        Array.from({ length: 20 }, (_, index) => index),
        (index) =>
          lock.withPermits(1)(
            record(`loop:${index}`).pipe(
              Effect.andThen(index === 0 ? Deferred.succeed(looping, undefined) : Effect.void),
              Effect.andThen(Effect.yieldNow),
            ),
          ),
        { discard: true },
      ).pipe(Effect.forkChild);
      yield* Deferred.await(looping);
      yield* lock.withPermits(1)(record("other"));
      yield* Fiber.join(loop);

      const events = yield* Ref.get(order);
      // Served after at most the hold in progress and the one already queued.
      assert.isAtMost(events.indexOf("other"), 3);
    }),
  );

  it.effect("serves waiters in arrival order", () =>
    Effect.gen(function* () {
      const lock = makeFairLock();
      const order = yield* Ref.make<ReadonlyArray<number>>([]);
      const release = yield* Deferred.make<void>();
      yield* lock.take(1);
      const fibers = yield* Effect.forEach([1, 2, 3, 4], (id) =>
        lock
          .withPermits(1)(Ref.update(order, (current) => [...current, id]))
          .pipe(
            Effect.forkChild,
            Effect.tap(() => Effect.yieldNow),
          ),
      );
      yield* Deferred.succeed(release, undefined);
      yield* lock.release(1);
      yield* Fiber.joinAll(fibers);
      assert.deepStrictEqual(yield* Ref.get(order), [1, 2, 3, 4]);
    }),
  );

  it.effect("an interrupted waiter passes the lock on", () =>
    Effect.gen(function* () {
      const lock = makeFairLock();
      yield* lock.take(1);
      const first = yield* lock.withPermits(1)(Effect.never).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      const second = yield* lock.withPermits(1)(Effect.succeed("second")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* Fiber.interrupt(first);
      yield* lock.release(1);
      assert.strictEqual(yield* Fiber.join(second), "second");
      // Free again afterwards.
      assert.isTrue(Option.isSome(yield* lock.withPermitsIfAvailable(1)(Effect.void)));
    }),
  );

  it.effect("an interrupted holder releases", () =>
    Effect.gen(function* () {
      const lock = makeFairLock();
      const entered = yield* Deferred.make<void>();
      const holder = yield* lock
        .withPermits(1)(Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)))
        .pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.isTrue(Option.isNone(yield* lock.withPermitsIfAvailable(1)(Effect.void)));
      yield* Fiber.interrupt(holder);
      assert.strictEqual(yield* lock.withPermits(1)(Effect.succeed(1)), 1);
    }),
  );

  it.effect("is not available to a newcomer while someone is queued", () =>
    Effect.gen(function* () {
      const lock = makeFairLock();
      yield* lock.take(1);
      const queued = yield* lock.withPermits(1)(Effect.succeed("queued")).pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* lock.release(1);
      // Released, but the queued fiber has not run yet: a newcomer must not barge.
      assert.isTrue(Option.isNone(yield* lock.withPermitsIfAvailable(1)(Effect.void)));
      assert.strictEqual(yield* Fiber.join(queued), "queued");
    }),
  );
});
