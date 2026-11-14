/**
 * t4 fork: write tool calls a T3 restart can cut (AI-93). A restart cut 50 MCP calls in a week
 * (ECONNRESET, "interrupted before a result") and the agent could not tell whether its handoff,
 * launch or wake had happened. Each call is logged when it starts and when it ends; the restart
 * continuation tells the agent which ones never finished and which did.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as T4Store from "./T4Store.ts";

/** Tools whose effect an agent must not repeat blindly. `t3_handoff` logs itself (its retry key). */
export const LOGGED_TOOLS: ReadonlySet<string> = new Set([
  "t3_thread_launch",
  "create_threads",
  "delegate_task",
  "t3_thread_send",
  "schedule_task",
  "delete_scheduled_task",
  "t3_thread_organize",
  "release_queue",
  "link_issue",
]);

const clip = (text: string, max: number) => {
  const flat = text.replaceAll(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
};

/** A short, recognisable description of a call: the arguments that say what it did. */
export const callSummary = (tool: string, args: unknown): string => {
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const parts: Array<string> = [];
  for (const key of [
    "action",
    "to",
    "threadId",
    "title",
    "pr",
    "prs",
    "identifier",
    "scheduledTaskId",
  ]) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    parts.push(`${key}: ${clip(typeof value === "string" ? value : JSON.stringify(value), 80)}`);
  }
  for (const key of ["message", "prompt", "task"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) {
      parts.push(`${key}: "${clip(value, 80)}"`);
      break;
    }
  }
  return `${tool}${parts.length === 0 ? "" : ` (${parts.join(", ")})`}`;
};

/** Runs a logged call: started before it runs, finished with its outcome after. */
export const logged = Effect.fn("t4.loggedToolCall")(function* <A, E, R>(
  store: T4Store.T4StoreShape,
  input: { readonly threadId: string; readonly tool: string; readonly args: unknown },
  run: Effect.Effect<A, E, R>,
  outcome: (value: A) => string,
) {
  const id = T4Store.newToolCallId();
  yield* store
    .startToolCall({
      id,
      threadId: input.threadId,
      tool: input.tool,
      summary: callSummary(input.tool, input.args),
    })
    .pipe(Effect.ignoreCause({ log: true }));
  return yield* run.pipe(
    Effect.onExit((exit) =>
      store
        .finishToolCall(id, exit._tag === "Success" ? outcome(exit.value) : "failed")
        .pipe(Effect.ignoreCause({ log: true })),
    ),
  );
});

/** The restart note's list of this thread's T3 tool calls from before the restart, or "". */
export const restartToolCallsNote = Effect.fn("t4.restartToolCallsNote")(function* (
  threadId: string,
) {
  const store = yield* Effect.serviceOption(T4Store.T4Store);
  if (Option.isNone(store)) return "";
  const calls = yield* store.value
    .takeRestartToolCalls(threadId)
    .pipe(Effect.orElseSucceed(() => []));
  const cut = calls.filter((call) => call.finishedAt === null);
  const done = calls.filter((call) => call.finishedAt !== null);
  if (cut.length === 0 && done.length === 0) return "";
  const lines: Array<string> = [];
  if (cut.length > 0) {
    lines.push(
      "These T3 tool calls of yours were still running when T3 restarted, so they may have run only in part. Check their effect (`t3_owed`, `t3_thread_list`, `list_scheduled_tasks`, `release_queue`) before you repeat one; a `t3_handoff` repeated with the same message (or `clientRequestId`) is sent only once:",
      ...cut.slice(0, 8).map((call) => `- ${call.summary}`),
    );
  }
  if (done.length > 0) {
    lines.push(
      "These finished before the restart, even if your side reported a connection error (ECONNRESET, interrupted) - don't repeat the ones that went through:",
      ...done.slice(-8).map((call) => `- ${call.summary}: ${clip(call.result ?? "done", 160)}`),
    );
  }
  return lines.join("\n");
});
