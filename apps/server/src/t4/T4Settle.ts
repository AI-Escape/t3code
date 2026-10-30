/**
 * t4 fork: settling a thread the t4 way.
 *
 * Behaviour contract: `cmd_settle`, `tick_settles` and `dev_footprint` in
 * t4's `t3agents.py`. A settle is refused for release managers and while the
 * thread owes anything. It winds down the worktree's dev footprint with the
 * repo's retire script, notes pending wakes, and records a request that the
 * sweep carries out once the turn has ended (T3 refuses to settle a running
 * thread). A message that reaches the thread after the request means it was
 * taken up again: the request is dropped and the thread told - unless every
 * later message was a notice (a handoff that asks nothing).
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import { CommandId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRunning, isSettled, shortId } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

export const SETTLE_CANCELLED_NOTE =
  "Note from the thread tools: your settle was cancelled because a message arrived after it. " +
  "Handle that message; if your work is still fully closed afterwards (nothing owed, nothing " +
  "awaiting the user), settle again as the last act of this turn.";

export type T4SettleRefusal = { readonly refused: string };

export interface T4SettleShape {
  /** Why this thread may not settle, or undefined. */
  readonly refusal: (thread: Shell) => Effect.Effect<string | undefined>;
  /** Retires the dev footprint, records the request; returns notes for the agent. */
  readonly request: (thread: Shell) => Effect.Effect<ReadonlyArray<string>>;
  /** `tick_settles()`: carry out or drop pending requests. */
  readonly sweep: Effect.Effect<void>;
}

export class T4Settle extends Context.Service<T4Settle, T4SettleShape>()("t3/t4/T4Settle") {}

export const make = Effect.gen(function* () {
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const config = yield* T4Config.T4ServerConfig;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const processes = yield* ProcessRunner.ProcessRunner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;

  const refusal: T4SettleShape["refusal"] = Effect.fn("t4.T4Settle.refusal")(
    function* (thread: Parameters<T4SettleShape["refusal"]>[0]) {
      const world = yield* ledger.world();
      if (ledger.isReleaseManager(world, thread)) {
        return "release managers never settle - say 'nothing queued, nothing in flight' in one line and stop";
      }
      const owing = world.live.filter((entry) => entry.toThreadId === thread.id);
      if (owing.length > 0) {
        const names = owing
          .slice(0, 5)
          .map((entry) => `"${entry.fromTitle}" (${shortId(entry.fromThreadId)})`)
          .join("; ");
        return `you still owe an answer to: ${names} - answer with \`t3_handoff\` (to that thread, done) first (\`t3_owed\`)`;
      }
      return undefined;
    },
    Effect.orElseSucceed(() => undefined),
  );

  const exists = (p: string) => fileSystem.exists(p).pipe(Effect.orElseSucceed(() => false));

  /** `dev_footprint()`: why the worktree has a dev environment to retire, or undefined. */
  const devFootprint = Effect.fn("t4.T4Settle.devFootprint")(function* (top: string) {
    if (yield* exists(path.join(top, ".env"))) return "port allocation";
    if (yield* exists(path.join(top, "backend", ".dev-neon-branch.json"))) return "database fork";
    const out = yield* processes
      .run({
        command: "docker",
        args: ["ps", "-a", "--format", '{{.Label "com.docker.compose.project.working_dir"}}'],
        timeout: "30 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(Effect.orElseSucceed(() => undefined));
    if (out === undefined) return "compose stack (unknown - docker unreachable)";
    return out.stdout.split(/\s+/).some((dir) => dir === top) ? "compose stack" : undefined;
  });

  /** The repo's retire script (e.g. `scripts/*dev-retire`), if it has one. */
  const retireScript = Effect.fn("t4.T4Settle.retireScript")(function* (top: string) {
    const glob = config.devRetireGlob;
    if (glob === null) return undefined;
    const dir = path.join(top, path.dirname(glob));
    const pattern = path.basename(glob);
    const suffix = pattern.startsWith("*") ? pattern.slice(1) : pattern;
    const entries = yield* fileSystem.readDirectory(dir).pipe(Effect.orElseSucceed(() => []));
    const match = entries.toSorted().find((entry) => entry.endsWith(suffix));
    return match === undefined ? undefined : path.join(dir, match);
  });

  const request: T4SettleShape["request"] = Effect.fn("t4.T4Settle.request")(function* (
    thread: Parameters<T4SettleShape["request"]>[0],
  ) {
    const notes: Array<string> = [];
    const at = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
    yield* store.setSettleRequest(thread.id, at).pipe(Effect.orDie);
    // A closed thread keeps nothing reserved: wind down its worktree's dev
    // footprint (ports, DB fork, compose stack). Best-effort - the reaper
    // covers any failure.
    if (thread.worktreePath !== null) {
      const script = yield* retireScript(thread.worktreePath);
      if (script !== undefined) {
        if ((yield* devFootprint(thread.worktreePath)) === undefined) {
          notes.push("no dev environment to retire");
        } else {
          const result = yield* processes
            .run({
              command: script,
              args: [],
              cwd: thread.worktreePath,
              timeout: "300 seconds",
              timeoutBehavior: "timedOutResult",
            })
            .pipe(Effect.orElseSucceed(() => undefined));
          notes.push(
            result === undefined
              ? "settle: retire failed - the reaper will clean up later"
              : result.timedOut
                ? "settle: retire timed out - the reaper will clean up later"
                : result.code === 0
                  ? "dev footprint retired"
                  : "settle: retire failed - the reaper will clean up later",
          );
        }
      }
    }
    // Wakes are scheduled tasks posted into this thread.
    const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
    const wakes =
      scheduledTasks._tag === "Some"
        ? (yield* scheduledTasks.value
            .list()
            .pipe(Effect.orElseSucceed(() => ({ tasks: [] })))).tasks.filter(
            (task) => task.threadId === thread.id && task.enabled && task.nextRunAt !== null,
          )
        : [];
    if (wakes.length > 0) {
      notes.push(
        `note: wake ${wakes.map((w) => `"${w.title}" (${w.id})`).join(", ")} still pending - cancel it (\`delete_scheduled_task\`) unless you mean to come back`,
      );
    }
    notes.push(
      `settling "${thread.title}" - it closes when this turn ends; do not start new work here`,
    );
    return notes;
  });

  const sweep: T4SettleShape["sweep"] = Effect.gen(function* () {
    const requests = yield* store.settleRequests();
    if (requests.size === 0) return;
    for (const [threadId, requestedAt] of requests) {
      const thread = yield* threads
        .getThreadShell(threadId as Shell["id"])
        .pipe(Effect.orElseSucceed(() => null));
      if (
        thread === null ||
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        isSettled(thread)
      ) {
        yield* store.clearSettleRequest(threadId);
        continue;
      }
      const askedMs = Date.parse(requestedAt);
      const latestUserMs =
        thread.latestUserMessageAt === null
          ? null
          : DateTime.toEpochMillis(thread.latestUserMessageAt);
      if (latestUserMs !== null && latestUserMs > askedMs) {
        const records = yield* threads
          .getProjectThreadRecords({ projectId: thread.projectId, threadId: thread.id }, [
            "messages",
          ])
          .pipe(Effect.orElseSucceed(() => null));
        const later = (records?.messages ?? []).filter(
          (message) =>
            message.role === "user" && DateTime.toEpochMillis(message.createdAt) > askedMs,
        );
        const notices = yield* store.noticeIds(later.map((message) => message.id));
        const onlyNotices = later.length > 0 && later.every((message) => notices.has(message.id));
        if (!onlyNotices) {
          yield* store.clearSettleRequest(threadId);
          yield* Effect.logInfo("t4 settle dropped: new message after the request", { threadId });
          yield* delivery
            .deliver({
              target: thread,
              text: SETTLE_CANCELLED_NOTE,
              force: true,
              createdBy: "system",
              creationSource: "server",
            })
            .pipe(Effect.ignore);
          continue;
        }
      }
      if (isRunning(thread) || thread.pendingRuntimeRequest !== null) continue;
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      const settled = yield* threads
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`t4:settle:${uuid}`),
          threadId: thread.id,
        })
        .pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );
      if (settled) {
        yield* store.clearSettleRequest(threadId);
        yield* Effect.logInfo("t4 settled", { threadId });
      }
    }
  }).pipe(Effect.ignoreCause({ log: true }));

  return T4Settle.of({ refusal, request, sweep });
});

export const layer = Layer.effect(T4Settle, make);
