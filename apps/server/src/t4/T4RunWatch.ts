/**
 * t4 fork: wake a thread when a GitHub Actions run finishes.
 *
 * usa-rs's release manager spent 50 h of one week inside `gh run watch` and
 * ~3,600 `gh run view` / `gh api` polls (2026-10-29). Blocking in a tool call
 * also kept handoffs waiting: a message to a running Codex turn lands only
 * after the call returns. `watch_workflow_run` records the run, the caller
 * ends its turn, and this job checks each watched run every 30 s and posts
 * one message into the thread when it completes - so the thread is idle
 * while it waits and any handoff starts its turn at once.
 *
 * Watches live in t4_meta (a handful at a time); one older than six hours is
 * dropped with a note.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Store from "./T4Store.ts";

const META_KEY = "workflow-run-watches";
const MAX_AGE_MS = 6 * 3600_000;
const MAX_PER_THREAD = 10;

const Watch = Schema.Struct({
  threadId: Schema.String,
  runId: Schema.String,
  repository: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  since: Schema.Number,
});
type Watch = typeof Watch.Type;
const Watches = Schema.fromJsonString(Schema.Array(Watch));
const decodeWatches = Schema.decodeUnknownEffect(Watches);

export interface WorkflowRun {
  readonly name: string;
  readonly title: string;
  readonly branch: string;
  readonly url: string;
  readonly status: string;
  readonly conclusion: string;
  readonly failedJobs: ReadonlyArray<string>;
}

const RunView = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayTitle: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
  jobs: Schema.optional(
    Schema.Array(
      Schema.Struct({
        name: Schema.optional(Schema.String),
        conclusion: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const decodeRunView = Schema.decodeUnknownEffect(Schema.fromJsonString(RunView));

const FAILED = new Set(["failure", "timed_out", "startup_failure", "action_required"]);

/** The message a finished run posts into its thread. */
export const finishedMessage = (watch: Watch, run: WorkflowRun) =>
  [
    `WORKFLOW RUN finished: ${run.name || "run"} #${watch.runId}${run.branch ? ` on ${run.branch}` : ""} - ${run.conclusion || run.status}.`,
    run.title ? `"${run.title}"` : null,
    run.url || null,
    run.failedJobs.length > 0 ? `Failed jobs: ${run.failedJobs.join(", ")}.` : null,
    watch.note ? `Your note: ${watch.note}` : null,
  ]
    .filter((line) => line !== null)
    .join("\n");

export class T4RunWatchError extends Schema.TaggedError<T4RunWatchError>()("T4RunWatchError", {
  message: Schema.String,
}) {}

export interface T4RunWatchShape {
  /** Reads the run; watches it unless it already finished. */
  readonly watch: (input: {
    readonly threadId: string;
    readonly runId: string;
    readonly repository: string | null;
    readonly cwd: string | null;
    readonly note: string | null;
  }) => Effect.Effect<{ readonly run: WorkflowRun; readonly watching: boolean }, T4RunWatchError>;
  /** Posts finished runs into their threads; drops stale watches. */
  readonly sweep: Effect.Effect<void>;
  /** The threads with at least one run watched. */
  readonly watchingThreads: Effect.Effect<ReadonlySet<string>>;
}

export class T4RunWatch extends Context.Service<T4RunWatch, T4RunWatchShape>()(
  "t3/t4/T4RunWatch",
) {}

export const make = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const processes = yield* ProcessRunner.ProcessRunner;
  // The tool adds while the job removes; one writer at a time.
  const lock = yield* Semaphore.make(1);

  const load = store.meta(META_KEY).pipe(
    Effect.flatMap((text) => (text === undefined ? Effect.succeed([]) : decodeWatches(text))),
    Effect.orElseSucceed((): ReadonlyArray<Watch> => []),
  );
  const save = (watches: ReadonlyArray<Watch>) =>
    Schema.encodeEffect(Watches)(watches).pipe(
      Effect.flatMap((text) => store.setMeta(META_KEY, text)),
      Effect.ignore,
    );

  const view = Effect.fn("t4.T4RunWatch.view")(function* (
    runId: string,
    repository: string | null,
    cwd: string | null,
  ) {
    const result = yield* processes
      .run({
        command: "gh",
        args: [
          "run",
          "view",
          runId,
          ...(repository === null ? [] : ["--repo", repository]),
          "--json",
          "name,displayTitle,headBranch,url,status,conclusion,jobs",
        ],
        ...(cwd === null ? {} : { cwd }),
        timeout: "30 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => new T4RunWatchError({ message: String(cause) })));
    if (result.timedOut || result.code !== 0) {
      return yield* new T4RunWatchError({
        message: (result.stderr || result.stdout).trim().slice(0, 400) || "gh run view failed",
      });
    }
    const run = yield* decodeRunView(result.stdout).pipe(
      Effect.mapError(() => new T4RunWatchError({ message: "gh run view returned no run" })),
    );
    return {
      name: run.name ?? "",
      title: run.displayTitle ?? "",
      branch: run.headBranch ?? "",
      url: run.url ?? "",
      status: run.status ?? "",
      conclusion: run.conclusion ?? "",
      failedJobs: (run.jobs ?? [])
        .filter((job) => FAILED.has(job.conclusion ?? ""))
        .map((job) => job.name ?? "job"),
    } satisfies WorkflowRun;
  });

  const watch: T4RunWatchShape["watch"] = Effect.fn("t4.T4RunWatch.watch")(function* (
    input: Parameters<T4RunWatchShape["watch"]>[0],
  ) {
    const run = yield* view(input.runId, input.repository, input.cwd);
    if (run.status === "completed") return { run, watching: false };
    const now = yield* Clock.currentTimeMillis;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const watches = yield* load;
        const others = watches.filter(
          (w) => !(w.threadId === input.threadId && w.runId === input.runId),
        );
        if (others.filter((w) => w.threadId === input.threadId).length >= MAX_PER_THREAD) {
          return yield* new T4RunWatchError({
            message: `this thread already watches ${MAX_PER_THREAD} runs`,
          });
        }
        yield* save([...others, { ...input, since: now }]);
      }),
    );
    return { run, watching: true };
  });

  const post = (threadId: string, text: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.flatMap((target) =>
        target === null || target.deletedAt !== null || target.archivedAt !== null
          ? Effect.void
          : delivery
              .deliver({ target, text, force: true, createdBy: "system", creationSource: "server" })
              .pipe(Effect.asVoid),
      ),
      Effect.ignore,
    );

  const sweep: T4RunWatchShape["sweep"] = Effect.gen(function* () {
    const watches = yield* load;
    if (watches.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const done = new Set<Watch>();
    for (const w of watches) {
      if (now - w.since > MAX_AGE_MS) {
        done.add(w);
        yield* post(
          w.threadId,
          `WORKFLOW RUN #${w.runId} was still running after six hours; the watch was dropped. Check it with \`ci run ${w.runId}\` and watch again if it should still be followed.`,
        );
        continue;
      }
      const run = yield* view(w.runId, w.repository, w.cwd).pipe(Effect.orElseSucceed(() => null));
      if (run === null || run.status !== "completed") continue;
      done.add(w);
      yield* post(w.threadId, finishedMessage(w, run));
      yield* Effect.logInfo("t4.workflow-run-finished", {
        threadId: w.threadId,
        runId: w.runId,
        conclusion: run.conclusion,
        watchedFor: DateTime.formatIso(DateTime.makeUnsafe(w.since)),
      });
    }
    if (done.size === 0) return;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const latest = yield* load;
        yield* save(
          latest.filter(
            (w) => ![...done].some((d) => d.threadId === w.threadId && d.runId === w.runId),
          ),
        );
      }),
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  const watchingThreads = load.pipe(
    Effect.map((watches) => new Set(watches.map((w) => w.threadId)) as ReadonlySet<string>),
  );

  return T4RunWatch.of({ watch, sweep, watchingThreads });
});

export const layer = Layer.effect(T4RunWatch, make);
