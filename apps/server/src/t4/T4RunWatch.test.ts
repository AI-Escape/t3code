import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Store from "./T4Store.ts";

/** Test runs name a short commit; GitHub knows it by this full SHA. */
const full = (commit: string) => commit.padEnd(40, "0");

const harness = () => {
  const meta = new Map<string, string>();
  const delivered: Array<{ threadId: string; text: string }> = [];
  const runs = new Map<string, Record<string, unknown>>();
  const listed: Array<string> = [];
  const settled = new Set<string>();
  const state = { listFails: false };
  const layer = T4RunWatch.layer.pipe(
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
              settledAt: settled.has(id) ? "2026-11-10T00:00:00.000Z" : null,
            } as never),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) => {
            if (input.args[0] === "api") {
              const commit = String(input.args[1]).split("/commits/")[1] ?? "";
              const known = commit !== "0000000";
              return Effect.succeed({
                stdout: known ? `${full(commit)}\n` : "",
                stderr: known ? "" : "gh: No commit found for SHA: 0000000 (HTTP 422)",
                code: known ? 0 : 1,
                timedOut: false,
              } as never);
            }
            if (input.args[1] === "list") {
              listed.push(String(input.args[3]));
              if (state.listFails)
                return Effect.succeed({
                  stdout: "",
                  stderr: "failed to determine base repo",
                  code: 1,
                  timedOut: false,
                } as never);
              const list = [...runs.entries()]
                .filter(([, r]) => full(String(r.commit)) === input.args[3])
                .map(([id, r]) => ({ databaseId: Number(id), ...r }));
              return Effect.succeed({
                stdout: JSON.stringify(list),
                stderr: "",
                code: 0,
                timedOut: false,
              } as never);
            }
            const run = runs.get(String(input.args[2]));
            return Effect.succeed({
              stdout: run === undefined ? "" : JSON.stringify(run),
              stderr: run === undefined ? "run not found" : "",
              code: run === undefined ? 1 : 0,
              timedOut: false,
            } as never);
          },
        }),
      ),
    ),
  );
  const use = <A, E>(f: (watch: T4RunWatch.T4RunWatchShape) => Effect.Effect<A, E>) =>
    T4RunWatch.T4RunWatch.pipe(Effect.flatMap(f), Effect.provide(layer));
  return { meta, delivered, runs, listed, settled, state, use };
};

const input = { threadId: "t4-rm", repository: null, cwd: "/srv/Code/usa-rs", note: null };

describe("t4 watch_workflow_run", () => {
  it.effect("reports a finished run at once, watches a running one, and posts when it ends", () =>
    Effect.gen(function* () {
      const h = harness();
      h.runs.set("1", { name: "Deploy", status: "completed", conclusion: "success", jobs: [] });
      h.runs.set("2", {
        name: "Production",
        headBranch: "main",
        url: "https://github.com/o/r/actions/runs/2",
        status: "in_progress",
        jobs: [],
      });

      const done = yield* h.use((w) => w.watch({ ...input, runId: "1" }));
      expect(done.watching).toBe(false);
      expect(h.meta.get("workflow-run-watches")).toBeUndefined();

      const watched = yield* h.use((w) => w.watch({ ...input, runId: "2", note: "notify owners" }));
      expect(watched.watching).toBe(true);

      yield* h.use((w) => w.sweep);
      expect(h.delivered).toEqual([]);

      h.runs.set("2", {
        ...h.runs.get("2"),
        status: "completed",
        conclusion: "failure",
        jobs: [
          { name: "build", conclusion: "success" },
          { name: "e2e", conclusion: "failure" },
        ],
      });
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.threadId).toBe("t4-rm");
      expect(h.delivered[0]!.text).toContain(
        "WORKFLOW RUN finished: Production #2 on main - failure.",
      );
      expect(h.delivered[0]!.text).toContain("Failed jobs: e2e.");
      expect(h.delivered[0]!.text).toContain("Your note: notify owners");
      expect(JSON.parse(h.meta.get("workflow-run-watches")!)).toEqual([]);
    }),
  );

  it.effect("refuses a run gh cannot read", () =>
    Effect.gen(function* () {
      const h = harness();
      const exit = yield* Effect.exit(h.use((w) => w.watch({ ...input, runId: "404" })));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect(
    "follows every run for a commit, including one that starts after the first finishes",
    () =>
      Effect.gen(function* () {
        const h = harness();
        h.runs.set("10", {
          commit: "abc1234",
          name: "Staging train",
          displayTitle: "staging",
          status: "in_progress",
        });
        const { runs } = yield* h.use((w) => w.watchCommit({ ...input, commit: "abc1234" }));
        expect(runs).toHaveLength(1);

        h.runs.set("10", { ...h.runs.get("10"), status: "completed", conclusion: "success" });
        yield* h.use((w) => w.sweep);
        expect(h.delivered).toHaveLength(1);
        expect(h.delivered[0]!.text).toContain("staging #10: success");

        // The production deploy the staging train triggers starts afterwards.
        h.runs.set("11", {
          commit: "abc1234",
          name: "Production",
          displayTitle: "production",
          status: "in_progress",
        });
        yield* h.use((w) => w.sweep);
        expect(h.delivered).toHaveLength(1);
        h.runs.set("11", { ...h.runs.get("11"), status: "completed", conclusion: "success" });
        yield* h.use((w) => w.sweep);
        expect(h.delivered).toHaveLength(2);
        expect(h.delivered[1]!.text).toContain("production #11: success");
        expect(yield* h.use((w) => w.watchingThreads)).toEqual(new Set(["t4-rm"]));
      }),
  );

  it.effect("holds runs that finish while others still run, and posts a failure at once", () =>
    Effect.gen(function* () {
      const h = harness();
      h.runs.set("20", { commit: "def5678", displayTitle: "staging", status: "in_progress" });
      h.runs.set("21", {
        commit: "def5678",
        displayTitle: "train decision",
        status: "in_progress",
      });
      h.runs.set("22", { commit: "def5678", displayTitle: "dashboard", status: "in_progress" });
      yield* h.use((w) => w.watchCommit({ ...input, commit: "def5678" }));

      // A decision succeeds and another is cancelled while staging runs: no wake.
      h.runs.set("21", { ...h.runs.get("21"), status: "completed", conclusion: "success" });
      h.runs.set("23", {
        commit: "def5678",
        displayTitle: "train decision",
        status: "completed",
        conclusion: "cancelled",
      });
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toEqual([]);

      // A failure posts with what was held, while staging still runs.
      h.runs.set("22", {
        ...h.runs.get("22"),
        status: "completed",
        conclusion: "failure",
        jobs: [],
      });
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.text).toContain("train decision #21: success");
      expect(h.delivered[0]!.text).toContain("dashboard #22: failure");
      expect(h.delivered[0]!.text).toContain("(1 more skipped or cancelled.)");
      expect(h.delivered[0]!.text).toContain("Still running: staging #20");

      h.runs.set("20", { ...h.runs.get("20"), status: "completed", conclusion: "success" });
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(2);
      expect(h.delivered[1]!.text).toContain("staging #20: success");
      expect(h.delivered[1]!.text).not.toContain("#21");
    }),
  );

  it.effect("does not watch a run twice when its commit is already watched", () =>
    Effect.gen(function* () {
      const h = harness();
      h.runs.set("30", {
        commit: "aaa1111",
        headSha: full("aaa1111"),
        displayTitle: "staging",
        status: "in_progress",
        jobs: [],
      });
      yield* h.use((w) => w.watchCommit({ ...input, commit: "aaa1111" }));
      const watched = yield* h.use((w) => w.watch({ ...input, runId: "30" }));
      expect(watched.watching).toBe(true);
      expect(h.meta.get("workflow-run-watches")).toBeUndefined();
    }),
  );

  it.effect("watches a short commit by its full SHA and refuses one GitHub can't find", () =>
    Effect.gen(function* () {
      const h = harness();
      h.runs.set("40", { commit: "cbdc633e1", displayTitle: "tests", status: "in_progress" });
      const watched = yield* h.use((w) => w.watchCommit({ ...input, commit: "cbdc633e1" }));
      expect(watched.commit).toBe(full("cbdc633e1"));
      expect(watched.runs).toHaveLength(1);
      expect(h.listed).toEqual([full("cbdc633e1")]);
      expect(JSON.parse(h.meta.get("workflow-commit-watches")!)[0].commit).toBe(full("cbdc633e1"));

      const exit = yield* Effect.exit(h.use((w) => w.watchCommit({ ...input, commit: "0000000" })));
      expect(Exit.isFailure(exit)).toBe(true);
    }),
  );

  it.effect("tells the thread when no run ever starts for the commit", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.use((w) =>
        w.watchCommit({ ...input, commit: "bbb2222", note: "hand it to release" }),
      );
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toEqual([]);

      yield* TestClock.adjust("21 minutes");
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.text).toContain("No workflow run started for commit bbb2222000");
      expect(h.delivered[0]!.text).toContain("Your note: hand it to release");
      expect(JSON.parse(h.meta.get("workflow-commit-watches")!)).toEqual([]);
    }),
  );

  it.effect("ends a watch GitHub can't read after six hours, quietly for a settled thread", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.use((w) => w.watchCommit({ ...input, commit: "ccc3333" }));
      yield* h.use((w) => w.watchCommit({ ...input, threadId: "t4-done", commit: "ddd4444" }));
      h.settled.add("t4-done");
      h.state.listFails = true;

      yield* TestClock.adjust("5 hours");
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toEqual([]);
      expect(JSON.parse(h.meta.get("workflow-commit-watches")!)).toHaveLength(2);

      yield* TestClock.adjust("2 hours");
      yield* h.use((w) => w.sweep);
      expect(h.delivered).toHaveLength(1);
      expect(h.delivered[0]!.threadId).toBe("t4-rm");
      expect(h.delivered[0]!.text).toContain("ended after six hours");
      expect(JSON.parse(h.meta.get("workflow-commit-watches")!)).toEqual([]);
    }),
  );
});
