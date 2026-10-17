/**
 * t4 fork: delivering a message into a thread the way t4's thread tools do.
 *
 * Behaviour contract: `deliver()` in t4's `t3agents.py`. A running turn gets
 * the message steered in; `interrupt` stops that turn and restarts it with
 * the message. Two side effects are spelled out to the agent in the message
 * itself:
 *   - a pending ask-user question can be closed by an incoming message
 *     (Claude) or read as its answer (Codex) - the message names it as still
 *     unanswered and has the agent ask again;
 *   - a steered message can cancel a running Claude tool call with Claude
 *     Code's "the user doesn't want to proceed" - the message says that was
 *     this message, not the user.
 * Release managers always receive turns on the configured release-manager
 * model (within their provider). A delivery that asks nothing of its
 * recipient is recorded as a notice, so a pending settle survives it.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRunning, shortId } from "./T4Threads.ts";

export class T4DeliveryError extends Schema.TaggedError<T4DeliveryError>()("T4DeliveryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface T4DeliverInput {
  readonly target: OrchestrationV2ThreadShell;
  readonly text: string;
  readonly senderThreadId?: ThreadId;
  readonly interrupt?: boolean;
  /** Skip the two notes (the server's own relays). */
  readonly force?: boolean;
  /** Asks nothing of the recipient: a pending settle stands. */
  readonly notice?: boolean;
  readonly createdBy?: "agent" | "user" | "system";
  readonly creationSource?: "mcp" | "server" | "web";
}

export interface T4DeliverResult {
  readonly messageId: MessageId;
  readonly delivery: "started" | "queued" | "steered" | "restarted";
  /** How t4's tools describe it to the sender. */
  readonly how: string;
}

export interface T4DeliveryShape {
  readonly deliver: (input: T4DeliverInput) => Effect.Effect<T4DeliverResult, T4DeliveryError>;
  /**
   * `cmd_msg`: a thread-to-thread message as t4 sends it - sender header, the
   * delivery notes; archived targets refused.
   */
  readonly decorate: (input: {
    readonly sender: OrchestrationV2ThreadShell;
    readonly target: OrchestrationV2ThreadShell;
    readonly text: string;
  }) => Effect.Effect<string, T4DeliveryError>;
}

export class T4Delivery extends Context.Service<T4Delivery, T4DeliveryShape>()(
  "t3/t4/T4Delivery",
) {}

export const UNANSWERED_QUESTION_NOTE = (questions: ReadonlyArray<string>) =>
  "You still have an unanswered question to the user: " +
  questions.map((q) => `"${q}"`).join("; ") +
  ". This message is NOT their answer, and it may have closed the question's prompt. " +
  "Handle this message, then ask the question again with your ask-user tool - unless " +
  "this message makes it moot.";

export const CANCELLED_TOOL_NOTE =
  'If a tool call of yours was just cancelled ("the user doesn\'t want to proceed"), this ' +
  "message cancelled it - not the user. The user has not asked you to stop; re-run it if you " +
  "still need it and carry on.";

export const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const store = yield* T4Store.T4Store;
  const ledger = yield* T4Ledger.T4Ledger;
  const config = yield* T4Config.T4ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  const fail = (message: string) => (cause: unknown) => new T4DeliveryError({ message, cause });

  /** Questions the target is still waiting on the user for. */
  const pendingQuestions = (target: OrchestrationV2ThreadShell) =>
    target.pendingRuntimeRequest?.kind !== "user_input"
      ? Effect.succeed([] as ReadonlyArray<string>)
      : threadManagement
          .getProjectThreadRecords({ projectId: target.projectId, threadId: target.id }, [
            "runtimeRequests",
            "turnItems",
          ])
          .pipe(
            Effect.map((records) => {
              const pending = new Set(
                records.runtimeRequests
                  .filter(
                    (request) => request.kind === "user_input" && request.status === "pending",
                  )
                  .map((request) => request.id as string),
              );
              return records.turnItems.flatMap((item) =>
                item.type === "user_input_request" && pending.has(item.requestId)
                  ? item.questions.map((question) => question.question || question.header)
                  : [],
              );
            }),
            Effect.orElseSucceed(() => [] as ReadonlyArray<string>),
          );

  /** The two delivery notes, prepended when they apply. */
  const withNotes = (target: OrchestrationV2ThreadShell, text: string) =>
    Effect.gen(function* () {
      const notes: Array<string> = [];
      const questions = yield* pendingQuestions(target);
      if (questions.length > 0) notes.push(UNANSWERED_QUESTION_NOTE(questions));
      if (target.providerInstanceId.startsWith("claude") && isRunning(target)) {
        notes.push(CANCELLED_TOOL_NOTE);
      }
      return notes.length === 0
        ? text
        : `${notes.map((note) => `(Thread tools: ${note})`).join("\n\n")}\n\n${text}`;
    });

  const decorate: T4DeliveryShape["decorate"] = (input) =>
    Effect.gen(function* () {
      if (input.target.archivedAt !== null) {
        return yield* new T4DeliveryError({
          message: `"${input.target.title}" is archived - its work is closed; start a new thread instead`,
        });
      }
      const header = `Message from thread "${input.sender.title}" (${shortId(input.sender.id)}):\n\n`;
      return yield* withNotes(input.target, header + input.text);
    });

  const deliver: T4DeliveryShape["deliver"] = (input) =>
    Effect.gen(function* () {
      if (input.target.archivedAt !== null) {
        return yield* new T4DeliveryError({
          message: `"${input.target.title}" is archived - its work is closed; start a new thread instead`,
        });
      }
      // The freshest view of the target decides the notes and the mode.
      const target =
        (yield* threadManagement
          .getThreadShell(input.target.id)
          .pipe(Effect.orElseSucceed(() => null))) ?? input.target;
      const running = isRunning(target);
      const text = input.force === true ? input.text : yield* withNotes(target, input.text);

      const world = yield* ledger.world().pipe(Effect.mapError(fail("t4 ledger unavailable")));
      const rmModel = config.releaseManagerModel;
      const modelSelection =
        rmModel !== null &&
        ledger.isReleaseManager(world, target) &&
        target.modelSelection.instanceId === rmModel.instanceId
          ? rmModel
          : undefined;

      const messageId = MessageId.make(yield* uuid);
      if (input.notice === true) {
        yield* store.addNotice(messageId).pipe(Effect.mapError(fail("t4 store unavailable")));
      }
      const result = yield* threadManagement
        .sendToThread({
          projectId: target.projectId,
          commandId: CommandId.make(`t4:deliver:${yield* uuid}`),
          threadId: target.id,
          messageId,
          ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
          text,
          attachments: [],
          ...(modelSelection === undefined ? {} : { modelSelection }),
          mode: input.interrupt === true && running ? "restart" : "auto",
          createdBy: input.createdBy ?? "agent",
          creationSource: input.creationSource ?? "mcp",
        })
        .pipe(Effect.mapError(fail(`could not deliver to "${target.title}"`)));
      const how =
        result.delivery === "restarted"
          ? "its turn was interrupted and restarted with your message"
          : result.delivery === "steered"
            ? "it was mid-turn; the message went straight into the running turn"
            : result.delivery === "queued"
              ? "it was starting a turn; the message is queued right behind it"
              : "delivered";
      return { messageId, delivery: result.delivery, how };
    });

  return T4Delivery.of({ deliver, decorate });
});

export const layer = Layer.effect(T4Delivery, make);
