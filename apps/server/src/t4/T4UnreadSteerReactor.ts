// t4 fork (AI-96): a steer that Stop dropped unread (`steer.updated` cancelled) is sent
// again as the next turn; Claude holds a steer until its running command returns.
import { CommandId, MessageId, type OrchestrationV2DomainEvent } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";

export const UNREAD_STEER_NOTE =
  "You were stopped before you read this message, which arrived while your last turn ran:";

export class T4UnreadSteerReactor extends Context.Service<
  T4UnreadSteerReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly handle: (event: OrchestrationV2DomainEvent) => Effect.Effect<void>;
  }
>()("t3/t4/T4UnreadSteerReactor") {}

const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  // Runs for every domain event; all but a dropped steer return at once.
  const handle: T4UnreadSteerReactor["Service"]["handle"] = Effect.fnUntraced(
    function* (event) {
      if (event.type !== "turn-item.updated") return;
      const item = event.payload;
      if (
        item.type !== "user_message" ||
        item.status !== "cancelled" ||
        (item.inputIntent !== "steer" && item.inputIntent !== "promoted_queued_to_steer")
      ) {
        return;
      }
      const thread = yield* projections.getThread(item.threadId);
      if (thread.archivedAt !== null || thread.deletedAt !== null) return;
      const message = (yield* projections.getMessagesById(item.threadId, [item.messageId])).get(
        item.messageId,
      );
      if (message === undefined) return;
      // Ids derive from the dropped message, so a replayed event sends it once.
      yield* engine.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:t4-unread-steer:${item.messageId}`),
        threadId: item.threadId,
        messageId: MessageId.make(`message:t4-unread-steer:${item.messageId}`),
        text: `${UNREAD_STEER_NOTE}\n\n${message.text}`,
        attachments: message.attachments,
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      });
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("t4: sending an unread steer again failed", {
            threadId: event.threadId,
            cause,
          }),
        ),
      ),
  );

  const start: T4UnreadSteerReactor["Service"]["start"] = () =>
    forkParked(
      Stream.runForEach(engine.streamDomainEvents, handle).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("t4: unread steer event stream failed", { cause }),
        ),
      ),
    );

  return { start, handle } satisfies T4UnreadSteerReactor["Service"];
});

export const layer = Layer.effect(T4UnreadSteerReactor, make);
