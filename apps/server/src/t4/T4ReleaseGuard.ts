/**
 * t4 fork: a release manager that owes releases never goes quiet.
 *
 * ai-escape's release manager merged PR #79, ended its turn with a watch on
 * the merged PR (which never fires) while both deploys ran, and sat idle: no
 * owner heard back (2026-10-30). Every 2 minutes, a release manager that is
 * idle, still owes handoffs, and has nothing set to wake it - no workflow-run
 * watch, no wake scheduled, no other thread owing it an answer - after 10
 * quiet minutes gets one note to pick its queue back up; at most one an hour
 * per thread. Any wake counts, however far off: shopify-theme-v2's release
 * manager was nudged three times while holding a release until the Monday
 * the user had named (2026-10-30).
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Store from "./T4Store.ts";
import { isRetired, isRunning, lastActivityMs, shortId } from "./T4Threads.ts";

const QUIET_MS = 10 * 60_000;
const REPEAT_MS = 60 * 60_000;
const nudgedKey = (threadId: string) => `release-guard:${threadId}`;

export const guardNote = (owes: ReadonlyArray<string>) =>
  `t4: you still owe ${owes.length} release${owes.length === 1 ? "" : "s"} (${owes.join("; ")}) and nothing is set to wake you - no workflow-run watch, no wake, no thread owing you an answer. Read your queue file and the real state (\`ci runs\`, \`gh pr list\`): for every release still running, \`watch_workflow_run\` with its merge \`commit\`; for every finished one, verify it and send the owner's \`shipped:\` or \`release failed\` notice now. Then end your turn.`;

export const sweep = Effect.gen(function* () {
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const runWatch = yield* T4RunWatch.T4RunWatch;
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const world = yield* ledger.world();
  const now = yield* Clock.currentTimeMillis;
  const managers = world.threads.filter(
    (thread) =>
      ledger.isReleaseManager(world, thread) &&
      !isRetired(thread) &&
      !isRunning(thread) &&
      thread.pendingRuntimeRequest === null &&
      now - lastActivityMs(thread) >= QUIET_MS,
  );
  if (managers.length === 0) return;
  const watching = yield* runWatch.watchingThreads;
  const { tasks } = yield* scheduled.list().pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
  for (const rm of managers) {
    const owed = world.live.filter((entry) => entry.toThreadId === rm.id);
    if (owed.length === 0 || watching.has(rm.id)) continue;
    // Waiting on another thread's answer (a diagnosis it asked for) is not quiet.
    if (world.live.some((entry) => entry.fromThreadId === rm.id)) continue;
    const wake = tasks.some(
      (task) =>
        task.threadId === rm.id &&
        task.enabled &&
        task.nextRunAt !== null &&
        Date.parse(String(task.nextRunAt)) > now,
    );
    if (wake) continue;
    const last = yield* store.meta(nudgedKey(rm.id)).pipe(Effect.orElseSucceed(() => undefined));
    if (last !== undefined && now - Number(last) < REPEAT_MS) continue;
    const fresh = yield* threads
      .getThreadShell(ThreadId.make(rm.id))
      .pipe(Effect.orElseSucceed(() => null));
    if (fresh === null || isRunning(fresh)) continue;
    yield* delivery
      .deliver({
        target: fresh,
        text: guardNote(owed.slice(0, 6).map((entry) => `"${entry.fromTitle}"`)),
        force: true,
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.ignore);
    yield* store.setMeta(nudgedKey(rm.id), String(now)).pipe(Effect.ignore);
    yield* Effect.logInfo("t4: idle release manager nudged", {
      threadId: shortId(rm.id),
      owes: owed.length,
    });
  }
}).pipe(Effect.ignoreCause({ log: true }));
