/**
 * t4 fork: a one-holder lock that serves waiters in arrival order. Effect's
 * Semaphore wakes waiters on a later tick, so a loop that releases and retakes
 * starves them (it stalled T3's single database reader). A free lock is taken only
 * when nobody is queued, and a release hands it straight to the longest waiter.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

interface Waiter {
  wake: (() => void) | undefined;
}

export interface FairLock {
  readonly withPermits: (n: 1) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
  readonly withPermitsIfAvailable: (
    n: 1,
  ) => <A, E, R>(self: Effect.Effect<A, E, R>) => Effect.Effect<Option.Option<A>, E, R>;
  /** Waits its turn; the caller must `release` exactly once after it succeeds. */
  readonly take: (n: 1) => Effect.Effect<number>;
  readonly release: (n: 1) => Effect.Effect<number>;
}

export const makeFairLock = (): FairLock => {
  let taken = false;
  const queue: Array<Waiter> = [];

  const wakeHead = () => {
    const head = queue[0];
    if (taken || head?.wake === undefined) return;
    const wake = head.wake;
    head.wake = undefined;
    // Resumed on a later tick, like Effect's Semaphore: never inside the
    // releasing fiber's finalizer. The head keeps its place meanwhile.
    queueMicrotask(wake);
  };

  const tryTake = (me: Waiter | undefined) => {
    if (taken || (queue.length > 0 && queue[0] !== me)) return false;
    if (me !== undefined) queue.shift();
    taken = true;
    return true;
  };

  const abandon = (me: Waiter) => {
    me.wake = undefined;
    const index = queue.indexOf(me);
    if (index >= 0) queue.splice(index, 1);
    wakeHead();
  };

  const releaseUnsafe = () => {
    taken = false;
    wakeHead();
  };

  const wait = (me: Waiter) =>
    Effect.callback<void>((resume) => {
      me.wake = () => resume(Effect.void);
      wakeHead();
      return Effect.sync(() => {
        me.wake = undefined;
      });
    });

  // Runs uninterruptibly except while waiting; an interrupted waiter leaves
  // the queue and passes a free lock on.
  const acquire = (restore: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      if (tryTake(undefined)) return Effect.void;
      const me: Waiter = { wake: undefined };
      queue.push(me);
      const loop: Effect.Effect<void> = Effect.suspend(() =>
        tryTake(me) ? Effect.void : Effect.flatMap(restore(wait(me)), () => loop),
      );
      return Effect.onInterrupt(loop, () => Effect.sync(() => abandon(me)));
    });

  return {
    withPermits: () => (self) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.flatMap(acquire(restore), () =>
          Effect.onExit(restore(self), () => Effect.sync(releaseUnsafe)),
        ),
      ),
    withPermitsIfAvailable: () => (self) =>
      Effect.uninterruptibleMask((restore) =>
        Effect.suspend(() =>
          tryTake(undefined)
            ? Effect.onExit(restore(Effect.asSome(self)), () => Effect.sync(releaseUnsafe))
            : Effect.succeedNone,
        ),
      ),
    take: () => Effect.uninterruptibleMask((restore) => Effect.as(acquire(restore), 1)),
    release: () =>
      Effect.sync(() => {
        releaseUnsafe();
        return taken ? 0 : 1;
      }),
  };
};
