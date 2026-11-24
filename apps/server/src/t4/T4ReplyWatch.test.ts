import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4ReplyWatch from "./T4ReplyWatch.ts";
import * as T4Store from "./T4Store.ts";

const harness = () => {
  const meta = new Map<string, string>();
  const delivered: Array<{ threadId: string; text: string }> = [];
  const ran: Array<{ check: string; cwd: string | undefined }> = [];
  const settled = new Set<string>();
  // What the next check prints: stdout, or a failing exit.
  const answer = { stdout: "", code: 0, stderr: "" };
  const layer = T4ReplyWatch.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(T4Store.T4Store)({
          meta: (key: string) => Effect.succeed(meta.get(key)),
          setMeta: (key: string, value: string) => Effect.sync(() => void meta.set(key, value)),
        }),
        Layer.mock(T4Delivery.T4Delivery)({
          deliver: (input) =>
            Effect.sync(() => {
              delivered.push({ threadId: input.target.id, text: input.text });
              return { delivery: "started", how: "" } as never;
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({
              id,
              deletedAt: null,
              archivedAt: null,
              settledOverride: null,
              settledAt: settled.has(id) ? "2026-11-23T00:00:00.000Z" : null,
            } as never),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) =>
            Effect.sync(() => {
              ran.push({ check: String(input.args[1]), cwd: input.cwd });
              return { ...answer, timedOut: false } as never;
            }),
        }),
      ),
    ),
  );
  const use = <A, E>(f: (w: T4ReplyWatch.T4ReplyWatchShape) => Effect.Effect<A, E>) =>
    T4ReplyWatch.T4ReplyWatch.pipe(Effect.flatMap(f), Effect.provide(layer));
  return { meta, delivered, ran, settled, answer, use };
};

const dolma = {
  threadId: "t-triage",
  who: "Dolma",
  about: "USA-3097 early-pay terms",
  check: "usars chat replies USA-3097 --since 2026-11-23T20:09:43Z --from Dolma",
  via: "chat",
  cwd: "/srv/Code/usa-rs",
  deadlineMs: 3_600_000,
  everyMs: 60_000,
};

describe("t4 wait_for_reply", () => {
  it.effect("checks on its interval and posts the reply once, then ends", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* TestClock.setTime(Date.parse("2026-11-23T20:10:00Z"));
      yield* h.use((w) => w.watch(dolma));

      yield* h.use((w) => w.sweep);
      expect(h.ran).toEqual([{ check: dolma.check, cwd: "/srv/Code/usa-rs" }]);
      expect(h.delivered).toEqual([]);

      // Within the minute: no second check.
      yield* TestClock.adjust("30 seconds");
      yield* h.use((w) => w.sweep);
      expect(h.ran).toHaveLength(1);

      h.answer.stdout =
        "2026-11-23 12:49 Dolma: Dexter, Vollrath and Vulcan are all JLA and net 30.\n";
      yield* TestClock.adjust("40 seconds");
      yield* h.use((w) => w.sweep);
      expect(h.ran).toHaveLength(2);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.threadId).toBe("t-triage");
      expect(h.delivered[0]!.text).toContain("REPLY from Dolma (USA-3097 early-pay terms)");
      expect(h.delivered[0]!.text).toContain("all JLA and net 30");
      expect(yield* h.use((w) => w.watches)).toEqual([]);

      yield* TestClock.adjust("5 minutes");
      yield* h.use((w) => w.sweep);
      expect(h.ran).toHaveLength(2);
    }),
  );

  it.effect("tells the thread when nobody replied by the deadline", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* TestClock.setTime(Date.parse("2026-11-23T20:10:00Z"));
      yield* h.use((w) => w.watch({ ...dolma, deadlineMs: 5 * 60_000 }));
      yield* h.use((w) => w.sweep);
      yield* TestClock.adjust("5 minutes");
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.text).toContain(
        "NO REPLY from Dolma (USA-3097 early-pay terms) by Mon 12:15 PM PT",
      );
      expect(yield* h.use((w) => w.watches)).toEqual([]);
    }),
  );

  it.effect("ends a check that keeps failing, with its error", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* TestClock.setTime(Date.parse("2026-11-23T20:10:00Z"));
      Object.assign(h.answer, { code: 2, stderr: "usars: unknown command 'chat'" });
      yield* h.use((w) => w.watch(dolma));
      for (let i = 0; i < 5; i++) {
        yield* h.use((w) => w.sweep);
        yield* TestClock.adjust("61 seconds");
      }
      expect(h.ran).toHaveLength(5);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.text).toContain("failed 5 times in a row");
      expect(h.delivered[0]!.text).toContain("unknown command 'chat'");
    }),
  );

  it.effect("replaces a watch on the same person, cancels, and drops a settled thread's", () =>
    Effect.gen(function* () {
      const h = harness();
      const first = yield* h.use((w) => w.watch(dolma));
      expect(first.replaced).toBe(false);
      const again = yield* h.use((w) => w.watch({ ...dolma, who: "dolma", deadlineMs: 7_200_000 }));
      expect(again.replaced).toBe(true);
      expect(yield* h.use((w) => w.watches)).toHaveLength(1);

      yield* h.use((w) => w.watch({ ...dolma, who: "Korin" }));
      const gone = yield* h.use((w) => w.cancel("t-triage", "Korin"));
      expect(gone.map((w) => w.who)).toEqual(["Korin"]);

      h.settled.add("t-triage");
      yield* h.use((w) => w.sweep);
      expect(h.ran).toEqual([]);
      expect(h.delivered).toEqual([]);
      expect(yield* h.use((w) => w.watches)).toEqual([]);
    }),
  );

  it("reads durations", () => {
    expect(T4ReplyWatch.parseDuration("5m")).toBe(300_000);
    expect(T4ReplyWatch.parseDuration("2h")).toBe(7_200_000);
    expect(T4ReplyWatch.parseDuration("3d")).toBe(259_200_000);
    expect(T4ReplyWatch.parseDuration("30")).toBe(1_800_000);
    expect(T4ReplyWatch.parseDuration("soon")).toBeNull();
    expect(T4ReplyWatch.defaultEvery(3_600_000)).toBe(60_000);
    expect(T4ReplyWatch.defaultEvery(2 * 86_400_000)).toBe(300_000);
  });
});
