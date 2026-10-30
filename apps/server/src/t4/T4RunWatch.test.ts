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

  it("holds runs that finish while others still run, and posts a failure at once", async () => {
    const h = harness();
    h.runs.set("20", { commit: "def5678", displayTitle: "staging", status: "in_progress" });
    h.runs.set("21", { commit: "def5678", displayTitle: "train decision", status: "in_progress" });
    h.runs.set("22", { commit: "def5678", displayTitle: "dashboard", status: "in_progress" });
    await h.use((w) => w.watchCommit({ ...input, commit: "def5678" }));

    // A decision succeeds and another is cancelled while staging runs: no wake.
    h.runs.set("21", { ...h.runs.get("21"), status: "completed", conclusion: "success" });
    h.runs.set("23", {
      commit: "def5678",
      displayTitle: "train decision",
      status: "completed",
      conclusion: "cancelled",
    });
    await h.use((w) => w.sweep);
    expect(h.delivered).toEqual([]);

    // A failure posts with what was held, while staging still runs.
    h.runs.set("22", { ...h.runs.get("22"), status: "completed", conclusion: "failure", jobs: [] });
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.text).toContain("train decision #21: success");
    expect(h.delivered[0]!.text).toContain("dashboard #22: failure");
    expect(h.delivered[0]!.text).toContain("(1 more skipped or cancelled.)");
    expect(h.delivered[0]!.text).toContain("Still running: staging #20");

    h.runs.set("20", { ...h.runs.get("20"), status: "completed", conclusion: "success" });
    await h.use((w) => w.sweep);
    expect(h.delivered).toHaveLength(2);
    expect(h.delivered[1]!.text).toContain("staging #20: success");
    expect(h.delivered[1]!.text).not.toContain("#21");
  });

  it("does not watch a run twice when its commit is already watched", async () => {
    const h = harness();
    h.runs.set("30", {
      commit: "aaa1111",
      headSha: "aaa1111ffff",
      displayTitle: "staging",
      status: "in_progress",
      jobs: [],
    });
    await h.use((w) => w.watchCommit({ ...input, commit: "aaa1111" }));
    const watched = await h.use((w) => w.watch({ ...input, runId: "30" }));
    expect(watched.watching).toBe(true);
    expect(h.meta.get("workflow-run-watches")).toBeUndefined();
  });
});
