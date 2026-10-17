/**
 * t4 fork: t4's background jobs on T3's shared scheduler (it ticks every 5 s
 * after startup recovery; each job throttles itself). Replaces the old
 * thread tools' 1-minute `tick`.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as T4LegacyImport from "./T4LegacyImport.ts";
import * as T4Settle from "./T4Settle.ts";
import * as T4Stalls from "./T4Stalls.ts";

/** Runs `job` at most once per `everyMs`. */
const throttled = <E, R>(everyMs: number, job: Effect.Effect<void, E, R>) =>
  Effect.gen(function* () {
    const last = yield* Ref.make(0);
    return Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      if (now - (yield* Ref.get(last)) < everyMs) return;
      yield* Ref.set(last, now);
      yield* job;
    });
  });

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    const settle = yield* T4Settle.T4Settle;
    // Once, after V2's own legacy import has created the thread shells.
    yield* scheduler.register("t4-legacy-import", yield* throttled(3600_000, T4LegacyImport.run));
    yield* scheduler.register("t4-settle-requests", yield* throttled(60_000, settle.sweep));
    yield* scheduler.register("t4-stall-recovery", yield* throttled(60_000, T4Stalls.sweep));
  }),
);
