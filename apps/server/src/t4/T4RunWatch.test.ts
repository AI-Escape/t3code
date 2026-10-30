import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, it } from "vite-plus/test";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Store from "./T4Store.ts";

const harness = () => {
  const meta = new Map<string, string>();
  const delivered: Array<{ threadId: string; text: string }> = [];
  const runs = new Map<string, Record<string, unknown>>();
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
            Effect.succeed({ id, deletedAt: null, archivedAt: null } as never),
        }),
        Layer.mock(ProcessRunner.ProcessRunner)({
          run: (input) => {
            if (input.args[1] === "list") {
              const list = [...runs.entries()]
                .filter(([, r]) => r.commit === input.args[3])
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
    Effect.runPromise(T4RunWatch.T4RunWatch.pipe(Effect.flatMap(f), Effect.provide(layer)));
  return { meta, delivered, runs, use };
};

const input = { threadId: "t4-rm", repository: null, cwd: "/srv/Code/usa-rs", note: null };

describe("t4 watch_workflow_run", () => {
  it("reports a finished run at once, watches a running one, and posts when it ends", async () => {
    const h = harness();
    h.runs.set("1", { name: "Deploy", status: "completed", conclusion: "success", jobs: [] });
    h.runs.set("2", {
      name: "Production",
      headBranch: "main",
      url: "https://github.com/o/r/actions/runs/2",
      status: "in_progress",
      jobs: [],
    });

    const done = await h.use((w) => w.watch({ ...input, runId: "1" }));
    expect(done.watching).toBe(false);
    expect(h.meta.get("workflow-run-watches")).toBeUndefined();

    const watched = await h.use((w) => w.watch({ ...input, runId: "2", note: "notify owners" }));
    expect(watched.watching).toBe(true);

    await h.use((w) => w.sweep);
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
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.threadId).toBe("t4-rm");
    expect(h.delivered[0]!.text).toContain(
      "WORKFLOW RUN finished: Production #2 on main - failure.",
    );
    expect(h.delivered[0]!.text).toContain("Failed jobs: e2e.");
    expect(h.delivered[0]!.text).toContain("Your note: notify owners");
    expect(JSON.parse(h.meta.get("workflow-run-watches")!)).toEqual([]);
  });

  it("refuses a run gh cannot read", async () => {
    const h = harness();
    await expect(h.use((w) => w.watch({ ...input, runId: "404" }))).rejects.toThrow();
  });

  it("follows every run for a commit, including one that starts after the first finishes", async () => {
    const h = harness();
    h.runs.set("10", {
      commit: "abc1234",
      name: "Staging train",
      displayTitle: "staging",
      status: "in_progress",
    });
    const runs = await h.use((w) => w.watchCommit({ ...input, commit: "abc1234" }));
    expect(runs).toHaveLength(1);

    h.runs.set("10", { ...h.runs.get("10"), status: "completed", conclusion: "success" });
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text).toContain("staging #10: success");

    // The production deploy the staging train triggers starts afterwards.
    h.runs.set("11", {
      commit: "abc1234",
      name: "Production",
      displayTitle: "production",
      status: "in_progress",
    });
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(1);
    h.runs.set("11", { ...h.runs.get("11"), status: "completed", conclusion: "success" });
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]!.text).toContain("production #11: success");
    expect(await h.use((w) => w.watchingThreads)).toEqual(new Set(["t4-rm"]));
  });
});
