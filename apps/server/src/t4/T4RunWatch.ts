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
  /** The run's name and URL when the watch began, for the dashboard. */
  name: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
type Watch = typeof Watch.Type;
const Watches = Schema.fromJsonString(Schema.Array(Watch));
const decodeWatches = Schema.decodeUnknownEffect(Watches);

/**
 * A watch on every run for a commit, including runs that start later - a
 * release train's staging run triggers its production run only when it ends,
 * so a watch on the staging run alone left the release manager with nothing
 * to wake it for production but a half-hourly wake (usa-rs, 2026-10-30).
 */
const CommitWatch = Schema.Struct({
  threadId: Schema.String,
  commit: Schema.String,
  repository: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  note: Schema.NullOr(Schema.String),
  since: Schema.Number,
  /** Runs already reported finished. */
  reported: Schema.Array(Schema.String),
  /** When a run last finished or started; the watch ends after a quiet spell. */
  lastActivity: Schema.Number,
  /**
   * Finished runs not posted yet. Successes, skips and cancellations wait
   * until nothing is running for the commit or a run fails: posting each one
   * woke usa-rs's release manager 216 times in 18 h, 115 of them only to say
   * "still running" (2026-10-30).
   */
  held: Schema.optional(Schema.Array(Schema.String)),
  /** Skipped or cancelled runs folded into the next message as a count. */
  quietRuns: Schema.optional(Schema.Number),
});
type CommitWatch = typeof CommitWatch.Type;
const CommitWatches = Schema.fromJsonString(Schema.Array(CommitWatch));
const COMMIT_META_KEY = "workflow-commit-watches";
/** With nothing running for this long after the last run ended, the chain is done. */
const COMMIT_QUIET_MS = 20 * 60_000;

const RunListItem = Schema.Struct({
  databaseId: Schema.Number,
  name: Schema.optional(Schema.String),
  workflowName: Schema.optional(Schema.String),
  displayTitle: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  conclusion: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
});
const decodeRunList = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(RunListItem)));

export interface WorkflowRun {
  readonly name: string;
  readonly title: string;
  readonly branch: string;
  readonly headSha: string;
  readonly url: string;
  readonly status: string;
  readonly conclusion: string;
  readonly failedJobs: ReadonlyArray<string>;
}

const RunView = Schema.Struct({
  name: Schema.optional(Schema.String),
  displayTitle: Schema.optional(Schema.String),
  headBranch: Schema.optional(Schema.String),
  headSha: Schema.optional(Schema.String),
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
/** Runs that did nothing worth reading on their own (a train decision that declined). */
const QUIET = new Set(["skipped", "cancelled", "neutral", "stale"]);

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
  /** Watches every run for a commit, those that start later included. */
  readonly watchCommit: (input: {
    readonly threadId: string;
    readonly commit: string;
    readonly repository: string | null;
    readonly cwd: string | null;
    readonly note: string | null;
  }) => Effect.Effect<
    ReadonlyArray<{ readonly runId: string; readonly name: string; readonly status: string }>,
    T4RunWatchError
  >;
  /** Posts finished runs into their threads; drops stale watches. */
  readonly sweep: Effect.Effect<void>;
  /** The threads with at least one run watched. */
  readonly watchingThreads: Effect.Effect<ReadonlySet<string>>;
  /** Every watched run, for the dashboard: a thread waiting on one is working. */
  readonly watches: Effect.Effect<
    ReadonlyArray<{
      readonly threadId: string;
      readonly runId: string;
      readonly name: string | null;
      readonly url: string | null;
      readonly since: string;
    }>
  >;
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
          "name,displayTitle,headBranch,headSha,url,status,conclusion,jobs",
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
      headSha: run.headSha ?? "",
      url: run.url ?? "",
      status: run.status ?? "",
      conclusion: run.conclusion ?? "",
      failedJobs: (run.jobs ?? [])
        .filter((job) => FAILED.has(job.conclusion ?? ""))
        .map((job) => job.name ?? "job"),
    } satisfies WorkflowRun;
  });

  const loadCommits = store.meta(COMMIT_META_KEY).pipe(
    Effect.flatMap((text) =>
      text === undefined ? Effect.succeed([]) : Schema.decodeEffect(CommitWatches)(text),
    ),
    Effect.orElseSucceed((): ReadonlyArray<CommitWatch> => []),
  );
  const saveCommits = (list: ReadonlyArray<CommitWatch>) =>
    Schema.encodeEffect(CommitWatches)(list).pipe(
      Effect.flatMap((text) => store.setMeta(COMMIT_META_KEY, text)),
      Effect.ignore,
    );

  const runsForCommit = Effect.fn("t4.T4RunWatch.runsForCommit")(function* (
    commit: string,
    repository: string | null,
    cwd: string | null,
  ) {
    const result = yield* processes
      .run({
        command: "gh",
        args: [
          "run",
          "list",
          "--commit",
          commit,
          ...(repository === null ? [] : ["--repo", repository]),
          "--limit",
          "50",
          "--json",
          "databaseId,name,workflowName,displayTitle,status,conclusion,url",
        ],
        ...(cwd === null ? {} : { cwd }),
        timeout: "30 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.mapError((cause) => new T4RunWatchError({ message: String(cause) })));
    if (result.timedOut || result.code !== 0) {
      return yield* new T4RunWatchError({
        message: (result.stderr || result.stdout).trim().slice(0, 400) || "gh run list failed",
      });
    }
    return yield* decodeRunList(result.stdout).pipe(
      Effect.mapError(() => new T4RunWatchError({ message: "gh run list returned no runs" })),
    );
  });

  const watchCommit: T4RunWatchShape["watchCommit"] = Effect.fn("t4.T4RunWatch.watchCommit")(
    function* (input: Parameters<T4RunWatchShape["watchCommit"]>[0]) {
      const runs = yield* runsForCommit(input.commit, input.repository, input.cwd);
      const now = yield* Clock.currentTimeMillis;
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const list = yield* loadCommits;
          const previous = list.find(
            (w) => w.threadId === input.threadId && w.commit === input.commit,
          );
          const reported =
            previous?.reported ??
            runs.filter((run) => run.status === "completed").map((run) => String(run.databaseId));
          yield* saveCommits([
            ...list.filter((w) => !(w.threadId === input.threadId && w.commit === input.commit)),
            { ...input, since: previous?.since ?? now, reported, lastActivity: now },
          ]);
        }),
      );
      return runs.map((run) => ({
        runId: String(run.databaseId),
        name: run.displayTitle || run.name || run.workflowName || "run",
        status: run.status === "completed" ? run.conclusion || "completed" : run.status || "",
      }));
    },
  );

  const sweepCommits = Effect.gen(function* () {
    const list = yield* loadCommits;
    if (list.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const next: Array<CommitWatch> = [];
    for (const w of list) {
      const runs = yield* runsForCommit(w.commit, w.repository, w.cwd).pipe(
        Effect.orElseSucceed(() => null),
      );
      if (runs === null) {
        next.push(w);
        continue;
      }
      const finished = runs.filter(
        (run) => run.status === "completed" && !w.reported.includes(String(run.databaseId)),
      );
      const running = runs.filter((run) => run.status !== "completed");
      let lastActivity = w.lastActivity;
      const held = [...(w.held ?? [])];
      let quietRuns = w.quietRuns ?? 0;
      let failed = false;
      if (finished.length > 0) lastActivity = now;
      for (const run of finished) {
        const conclusion = run.conclusion || "completed";
        if (QUIET.has(conclusion)) {
          quietRuns += 1;
          continue;
        }
        const detail =
          conclusion === "success"
            ? null
            : yield* view(String(run.databaseId), w.repository, w.cwd).pipe(
                Effect.orElseSucceed(() => null),
              );
        if (conclusion !== "success") failed = true;
        held.push(
          `- ${run.displayTitle || run.name || run.workflowName} #${run.databaseId}: ${conclusion}${detail && detail.failedJobs.length > 0 ? ` (failed: ${detail.failedJobs.join(", ")})` : ""} ${run.url ?? ""}`.trim(),
        );
      }
      const reported = [...w.reported, ...finished.map((run) => String(run.databaseId))];
      const expired = now - w.since > MAX_AGE_MS;
      // Post on a failure, or once nothing for the commit is running (a
      // stage of the release is over); hold everything in between.
      if (held.length > 0 && (failed || running.length === 0 || expired)) {
        yield* post(
          w.threadId,
          [
            `WORKFLOW RUNS finished for commit ${w.commit.slice(0, 10)}:`,
            ...held,
            quietRuns > 0 ? `(${quietRuns} more skipped or cancelled.)` : null,
            running.length > 0
              ? `Still running: ${running.map((run) => `${run.displayTitle || run.name} #${run.databaseId}`).join("; ")} - you will be woken when they finish or one fails.`
              : expired
                ? "The watch ended after six hours."
                : "Nothing else is running for this commit; a run it triggers later is still watched for 20 minutes.",
            w.note ? `Your note: ${w.note}` : null,
          ]
            .filter((line) => line !== null)
            .join("\n"),
        );
        held.length = 0;
        quietRuns = 0;
      }
      const quiet = running.length === 0 && now - lastActivity > COMMIT_QUIET_MS;
      if (quiet || expired) continue;
      next.push({
        ...w,
        reported,
        held,
        quietRuns,
        lastActivity: running.length > 0 ? now : lastActivity,
      });
    }
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // Keep watches added while this sweep ran.
        const latest = yield* loadCommits;
        const swept = new Set(list.map((w) => `${w.threadId} ${w.commit}`));
        yield* saveCommits([
          ...next,
          ...latest.filter((w) => !swept.has(`${w.threadId} ${w.commit}`)),
        ]);
      }),
    );
  });

  const watch: T4RunWatchShape["watch"] = Effect.fn("t4.T4RunWatch.watch")(function* (
    input: Parameters<T4RunWatchShape["watch"]>[0],
  ) {
    const run = yield* view(input.runId, input.repository, input.cwd);
    if (run.status === "completed") return { run, watching: false };
    // Already followed by this thread's watch on the run's commit: a second
    // watch only posts the same finish twice (46 duplicates on 2026-10-30).
    const commits = yield* loadCommits;
    if (
      run.headSha !== "" &&
      commits.some(
        (w) =>
          w.threadId === input.threadId &&
          (run.headSha.startsWith(w.commit) || w.commit.startsWith(run.headSha)),
      )
    ) {
      return { run, watching: true };
    }
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
        yield* save([...others, { ...input, since: now, name: run.name, url: run.url }]);
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
    yield* sweepCommits.pipe(Effect.ignoreCause({ log: true }));
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

  const watchingThreads = Effect.all([load, loadCommits]).pipe(
    Effect.map(
      ([watches, commits]) =>
        new Set([...watches, ...commits].map((w) => w.threadId)) as ReadonlySet<string>,
    ),
  );

  const watches = Effect.all([load, loadCommits]).pipe(
    Effect.map(([list, commits]) => [
      ...list.map((w) => ({
        threadId: w.threadId,
        runId: w.runId,
        name: w.name ?? null,
        url: w.url ?? null,
        since: DateTime.formatIso(DateTime.makeUnsafe(w.since)),
      })),
      ...commits.map((w) => ({
        threadId: w.threadId,
        runId: `commit ${w.commit.slice(0, 10)}`,
        name: `every run for commit ${w.commit.slice(0, 10)}`,
        url: null,
        since: DateTime.formatIso(DateTime.makeUnsafe(w.since)),
      })),
    ]),
  );

  return T4RunWatch.of({ watch, watchCommit, sweep, watchingThreads, watches });
});

export const layer = Layer.effect(T4RunWatch, make);
