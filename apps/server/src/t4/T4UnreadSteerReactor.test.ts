import { assert, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { T4UnreadSteerReactor, UNREAD_STEER_NOTE, layer } from "./T4UnreadSteerReactor.ts";

const threadId = ThreadId.make("thread:unread-steer");
const messageId = MessageId.make("message:typed-mid-turn");
const typed = "I've decided against arm if it's that heavy";

const steerEvent = (payload: Record<string, unknown>) =>
  ({
    type: "turn-item.updated",
    threadId,
    runId: RunId.make("run:stopped"),
    payload: {
      id: TurnItemId.make(`turn-item:message:${messageId}`),
      threadId,
      runId: RunId.make("run:stopped"),
      type: "user_message",
      messageId,
      inputIntent: "steer",
      status: "cancelled",
      ...payload,
    },
  }) as unknown as OrchestrationV2DomainEvent;

const run = (
  events: ReadonlyArray<OrchestrationV2DomainEvent>,
  thread: { archivedAt: string | null } = { archivedAt: null },
) =>
  Effect.gen(function* () {
    const dispatched: Array<Parameters<Orchestrator.OrchestratorV2["Service"]["dispatch"]>[0]> = [];
    const reactor = yield* T4UnreadSteerReactor.pipe(
      Effect.provide(
        layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Orchestrator.OrchestratorV2)({
                dispatch: (command) => {
                  dispatched.push(command);
                  return Effect.succeed({} as never);
                },
              }),
              Layer.mock(ProjectionStore.ProjectionStoreV2)({
                getThread: () =>
                  Effect.succeed({ id: threadId, deletedAt: null, ...thread } as never),
                getMessagesById: (_threadId, ids) =>
                  Effect.succeed(
                    new Map(
                      ids.map((id) => [id, { id, text: typed, attachments: [] }] as const),
                    ) as never,
                  ),
              }),
            ),
          ),
        ),
      ),
    );
    for (const event of events) yield* reactor.handle(event);
    return dispatched;
  });

// AI-85, 2026-11-12: two messages typed while a command ran, then Stop.
it.effect("sends a steer Stop dropped unread as the next turn", () =>
  Effect.gen(function* () {
    const [command, ...rest] = yield* run([steerEvent({})]);
    assert.lengthOf(rest, 0);
    assert.equal(command?.type, "message.dispatch");
    if (command?.type !== "message.dispatch") return;
    assert.equal(command.threadId, threadId);
    assert.equal(command.text, `${UNREAD_STEER_NOTE}\n\n${typed}`);
    assert.deepEqual(command.dispatchMode, { type: "queue_after_active" });
    // Derived ids: a replayed event dispatches the same command, which T3 dedupes.
    assert.equal(command.commandId, `server:t4-unread-steer:${messageId}`);
    assert.equal(command.messageId, `message:t4-unread-steer:${messageId}`);
  }),
);

it.effect("leaves read steers, other messages and closed threads alone", () =>
  Effect.gen(function* () {
    assert.lengthOf(
      yield* run([
        steerEvent({ status: "completed" }),
        steerEvent({ status: "pending" }),
        steerEvent({ inputIntent: "turn_start" }),
        steerEvent({ type: "assistant_message" }),
      ]),
      0,
    );
    assert.lengthOf(yield* run([steerEvent({})], { archivedAt: "2026-11-13T00:00:00.000Z" }), 0);
    assert.lengthOf(yield* run([steerEvent({ inputIntent: "promoted_queued_to_steer" })]), 1);
  }),
);
