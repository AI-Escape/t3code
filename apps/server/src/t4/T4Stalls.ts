/**
 * t4 fork: recover turns that hang. Behaviour contract: `tick_stalled_turns`
 * and `stalled_turn` in t4's `t3agents.py` (USA-884 sat "running" for 5.5 h
 * with no output). A running turn that has produced nothing for
 * `silenceMinutes` - no item in its run updated, not waiting on the user, no
 * tool call still executing (a long foreground test run is not a stall) - is
 * interrupted and restarted with a note. A thread that stalls again within
 * `repeatHours` is stopped and pushed to the user instead of looped.
 */
import { CommandId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRunning, shortId } from "./T4Threads.ts";

const TOOL_ITEM_TYPES = new Set([
  "command_execution",
  "file_change",
  "dynamic_tool",
  "web_search",
  "file_search",
  "subagent",
]);

export const stallNote = (minutes: number) =>
  `(Thread tools: your turn stalled - no output for ${minutes} minutes - and was restarted. Any ` +
  "messages that arrived meanwhile are above in the conversation. Pick up where you were; if you " +
  "were waiting on the user's answer to a question, ask it again with your ask-user tool.)";

/** A phone push (Pushover; keys from the environment) linking the t4 dashboard. */
export const pushUser = Effect.fn("t4.T4Stalls.pushUser")(function* (
  title: string,
  message: string,
) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) return;
  const client = yield* Effect.serviceOption(HttpClient.HttpClient);
  if (Option.isNone(client)) return;
  const form = new URLSearchParams({
    token,
    user,
    title: title.slice(0, 250),
    message: message.slice(0, 1000),
  });
  if (process.env.T4_UI_URL) {
    form.set("url", process.env.T4_UI_URL);
    form.set("url_title", "Open t4");
  }
  yield* client.value
    .execute(
      HttpClientRequest.post("https://api.pushover.net/1/messages.json").pipe(
        HttpClientRequest.bodyUrlParams(form),
      ),
    )
    .pipe(Effect.timeout(Duration.seconds(10)), Effect.ignore);
});

/** Minutes the thread's running turn has been silent, or undefined if it isn't stalled. */
export const silentMinutes = Effect.fn("t4.silentMinutes")(function* (
  thread: OrchestrationV2ThreadShell,
  silenceMinutes: number,
) {
  if (!isRunning(thread) || thread.pendingRuntimeRequest !== null || thread.activeRunId === null)
    return undefined;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const records = yield* threads
    .getProjectThreadRecords({ projectId: thread.projectId, threadId: thread.id }, [
      "turnItems",
      "runs",
    ])
    .pipe(Effect.orElseSucceed(() => null));
  if (records === null) return undefined;
  const run = records.runs.find((candidate) => candidate.id === thread.activeRunId);
  const items = records.turnItems.filter((item) => item.runId === thread.activeRunId);
  if (
    items.some(
      (item) =>
        TOOL_ITEM_TYPES.has(item.type) && (item.status === "running" || item.status === "pending"),
    )
  ) {
    return undefined;
  }
  const stamps = [
    ...items.map((item) => DateTime.toEpochMillis(item.updatedAt)),
    ...(run?.startedAt == null ? [] : [DateTime.toEpochMillis(run.startedAt)]),
  ];
  if (stamps.length === 0) return undefined;
  const minutes = ((yield* Clock.currentTimeMillis) - Math.max(...stamps)) / 60_000;
  return minutes >= silenceMinutes ? Math.round(minutes) : undefined;
});

export const sweep = Effect.gen(function* () {
  const config = yield* T4Config.T4ServerConfig;
  if (!config.stallRecovery.enabled) return;
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const crypto = yield* Crypto.Crypto;
  const world = yield* ledger.world();
  for (const thread of world.threads.filter((t) => isRunning(t))) {
    const minutes = yield* silentMinutes(thread, config.stallRecovery.silenceMinutes);
    if (minutes === undefined) continue;
    const now = yield* Clock.currentTimeMillis;
    const since = DateTime.formatIso(
      DateTime.makeUnsafe(now - config.stallRecovery.repeatHours * 3600_000),
    );
    const previous = yield* store.recentStalls(thread.id, since);
    const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
    const interrupted = yield* threads
      .interruptThread({
        projectId: thread.projectId,
        commandId: CommandId.make(`t4:stall:${uuid}`),
        threadId: thread.id,
        reason: "t4 stall recovery",
      })
      .pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
    if (!interrupted) continue;
    yield* store.addStall(thread.id, DateTime.formatIso(DateTime.makeUnsafe(now)));
    if (previous.length > 0) {
      yield* Effect.logInfo("t4: stalled again - interrupted, left for the user", {
        threadId: thread.id,
        minutes,
      });
      yield* pushUser(
        `${process.env.T4_LABEL ?? "t4"} · ${thread.title.slice(0, 80)}`,
        `This thread's turn stalled twice within ${config.stallRecovery.repeatHours}h (no output for ${minutes} min). It was stopped, not restarted - it needs a look.`,
      );
      continue;
    }
    yield* Effect.sleep(Duration.seconds(2));
    const fresh =
      (yield* threads.getThreadShell(thread.id).pipe(Effect.orElseSucceed(() => null))) ?? thread;
    yield* delivery
      .deliver({
        target: fresh,
        text: stallNote(minutes),
        force: true,
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.ignore);
    yield* Effect.logInfo("t4: stalled turn interrupted and restarted", {
      threadId: shortId(thread.id),
      minutes,
    });
  }
}).pipe(Effect.ignoreCause({ log: true }));
