/**
 * t4 fork: settled threads are archived two days after they settle.
 *
 * T3's shell - the thread list every page load, reconnect, phone and
 * dashboard poll reads - carries every thread that isn't archived. usa-rs
 * reached 970 (680 settled, 214 subagent helpers); loading the list took 4-7 s
 * and answering a question stalled behind it under load (2026-10-31; the user
 * chose two days). Archived threads stay searchable and restorable from the
 * dashboard's Archived tab (Restore unarchives and unsettles).
 *
 * Archived here: settled threads `T4_ARCHIVE_SETTLED_HOURS` (default 48; 0
 * turns it off) after they settled, and subagent threads whose parent is
 * archived, gone, or archived by this pass. Never: release managers, and any
 * thread that is running, waiting on a request or has background work.
 * At most `PER_PASS` a pass, so a backlog drains over a few passes.
 */
import { CommandId, type OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Ledger from "./T4Ledger.ts";
import { isRunning, isSettled, shortId } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

const PER_PASS = 100;
const hoursSetting = Number(process.env.T4_ARCHIVE_SETTLED_HOURS ?? "48");
export const ARCHIVE_SETTLED_MS =
  Number.isFinite(hoursSetting) && hoursSetting > 0 ? hoursSetting * 3600_000 : null;

const busy = (thread: Shell) =>
  isRunning(thread) ||
  thread.pendingRuntimeRequest !== null ||
  (thread.pendingBackgroundTasks?.length ?? 0) > 0;

/** The threads to archive now, given the active (non-archived) threads. */
export const toArchive = (
  threads: ReadonlyArray<Shell>,
  isReleaseManager: (thread: Shell) => boolean,
  nowMs: number,
  afterMs: number,
): ReadonlyArray<Shell> => {
  const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
  const longSettled = (thread: Shell) =>
    thread.archivedAt === null &&
    thread.deletedAt === null &&
    isSettled(thread) &&
    nowMs - DateTime.toEpochMillis(thread.settledAt ?? thread.updatedAt) >= afterMs &&
    // Untouched as long too: a thread unarchived in T3's own UI (which leaves
    // it settled) is not archived again right away. The dashboard's Restore
    // also unsettles it.
    nowMs - DateTime.toEpochMillis(thread.updatedAt) >= afterMs &&
    !busy(thread) &&
    !isReleaseManager(thread);
  const settled = threads.filter(
    (thread) => thread.lineage.relationshipToParent !== "subagent" && longSettled(thread),
  );
  const archived = new Set(settled.map((thread) => thread.id as string));
  const helpers = threads.filter((thread) => {
    if (thread.lineage.relationshipToParent !== "subagent") return false;
    if (thread.archivedAt !== null || thread.deletedAt !== null || busy(thread)) return false;
    const parentId = thread.lineage.parentThreadId;
    if (parentId === null) return false;
    // A parent missing from the active threads is archived or gone.
    return !byId.has(parentId) || archived.has(parentId);
  });
  return [...settled, ...helpers].slice(0, PER_PASS);
};

export const sweep = Effect.gen(function* () {
  if (ARCHIVE_SETTLED_MS === null) return;
  const ledger = yield* T4Ledger.T4Ledger;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const world = yield* ledger.world();
  const now = yield* Clock.currentTimeMillis;
  const targets = toArchive(
    world.threads,
    (thread) => ledger.isReleaseManager(world, thread),
    now,
    ARCHIVE_SETTLED_MS,
  );
  if (targets.length === 0) return;
  let done = 0;
  for (const thread of targets) {
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const ok = yield* threads
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`t4:auto-archive:${uuid}`),
        threadId: ThreadId.make(thread.id),
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          Effect.logWarning("t4: auto-archive failed", {
            threadId: shortId(thread.id),
            cause,
          }).pipe(Effect.as(false)),
        ),
      );
    if (ok) done += 1;
  }
  yield* Effect.logInfo("t4: archived settled threads", { archived: done, of: targets.length });
}).pipe(Effect.ignoreCause({ log: true }));
