import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect, it } from "vite-plus/test";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4ReleaseGuard from "./T4ReleaseGuard.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Store from "./T4Store.ts";

const HOUR = 3600_000;

const harness = (input: { watching?: boolean; wakeInMs?: number; running?: boolean }) => {
  const rm = {
    id: "t4-rm",
    title: "Release manager — app",
    status: input.running ? "running" : "completed",
    activeRunId: input.running ? "run" : null,
    pendingRuntimeRequest: null,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    updatedAt: DateTime.makeUnsafe(0),
    createdAt: DateTime.makeUnsafe(0),
    latestRunCompletedAt: DateTime.makeUnsafe(0),
    latestUserMessageAt: null,
  } as never;
  const meta = new Map<string, string>();
  const delivered: Array<string> = [];
  const layer = Layer.mergeAll(
    Layer.mock(T4Ledger.T4Ledger)({
      world: () =>
        Effect.succeed({
          threads: [rm],
          byId: new Map([["t4-rm", rm]]),
          releaseManagers: new Set(["t4-rm"]),
          open: [],
          live: [{ toThreadId: "t4-rm", fromThreadId: "t4-owner", fromTitle: "APP-1 Fix it" }],
        } as never),
      isReleaseManager: () => true,
      facts: () => ({ isReleaseManager: true, owes: 1, owedBy: 0 }),
    }),
    Layer.mock(T4Store.T4Store)({
      meta: (key: string) => Effect.succeed(meta.get(key)),
      setMeta: (key: string, value: string) => Effect.sync(() => void meta.set(key, value)),
    }),
    Layer.mock(T4Delivery.T4Delivery)({
      deliver: (d) =>
        Effect.sync(() => {
          delivered.push(d.text);
          return { delivery: "started", how: "" } as never;
        }),
    }),
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadShell: () => Effect.succeed(rm),
    }),
    Layer.mock(T4RunWatch.T4RunWatch)({
      watchingThreads: Effect.succeed(new Set(input.watching ? ["t4-rm"] : [])),
    }),
    Layer.mock(ScheduledTasks.ScheduledTaskService)({
      list: () =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          return {
            tasks:
              input.wakeInMs === undefined
                ? []
                : [
                    {
                      threadId: "t4-rm",
                      enabled: true,
                      nextRunAt: DateTime.formatIso(DateTime.makeUnsafe(now + input.wakeInMs)),
                    },
                  ],
          } as never;
        }),
    }),
    TestClock.layer(),
  );
  const run = (f: Effect.Effect<void, never, never>) =>
    Effect.runPromise(f.pipe(Effect.provide(layer)));
  return { delivered, run };
};

describe("t4 release guard", () => {
  it("nudges an idle release manager that owes and has nothing to wake it, once an hour", async () => {
    const h = harness({});
    await h.run(
      Effect.gen(function* () {
        yield* TestClock.adjust("20 minutes");
        yield* T4ReleaseGuard.sweep;
        yield* T4ReleaseGuard.sweep;
        expect(h.delivered).toHaveLength(1);
        expect(h.delivered[0]).toContain('you still owe 1 release ("APP-1 Fix it")');
        yield* TestClock.adjust(HOUR);
        yield* T4ReleaseGuard.sweep;
        expect(h.delivered).toHaveLength(2);
      }) as never,
    );
  });

  it("leaves it alone while a run is watched, a wake is due soon, or it is running", async () => {
    for (const input of [{ watching: true }, { wakeInMs: 10 * 60_000 }, { running: true }]) {
      const h = harness(input);
      await h.run(
        Effect.gen(function* () {
          yield* TestClock.adjust("20 minutes");
          yield* T4ReleaseGuard.sweep;
          expect(h.delivered).toEqual([]);
        }) as never,
      );
    }
  });
});
