import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as FyiDigest from "./fyiDigest.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Store from "./T4Store.ts";

describe("t4 fyi digests", () => {
  it.effect(
    "delivers the first fyi, bundles the next ones, and sends them once the window passes",
    () => {
      const meta = new Map<string, string>();
      const delivered: Array<string> = [];
      const services = Layer.mergeAll(
        Layer.mock(T4Store.T4Store)({
          meta: (key: string) => Effect.succeed(meta.get(key)),
          setMeta: (key: string, value: string) => Effect.sync(() => void meta.set(key, value)),
        }),
        Layer.mock(T4Delivery.T4Delivery)({
          deliver: (input) =>
            Effect.sync(() => {
              delivered.push(input.text);
              return { delivery: "started", how: "" } as never;
            }),
        }),
        Layer.mock(ThreadManagementService.ThreadManagementService)({
          getThreadShell: (id) =>
            Effect.succeed({ id, deletedAt: null, archivedAt: null } as never),
        }),
      );
      const fyi = (body: string) =>
        FyiDigest.queueIfRecent({ from: "t4-rm", fromTitle: "Release manager", to: "t4-pm", body });

      return Effect.gen(function* () {
        expect(yield* fyi("first")).toBe(false);
        yield* FyiDigest.noteDelivered("t4-rm", "t4-pm");
        yield* TestClock.adjust("1 minute");
        expect(yield* fyi("second")).toBe(true);
        expect(yield* fyi("third")).toBe(true);
        yield* FyiDigest.sweep;
        expect(delivered).toEqual([]);
        yield* TestClock.adjust("10 minutes");
        yield* FyiDigest.sweep;
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toContain("2 updates, bundled");
        expect(delivered[0]).toContain("second\n\n---\n\nthird");
        // The digest restarts the window.
        expect(yield* fyi("fourth")).toBe(true);
      }).pipe(Effect.provide(services));
    },
  );
});
