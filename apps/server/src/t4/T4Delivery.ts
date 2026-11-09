/**
 * t4 fork: delivering a message like t4's `deliver()`: steered into a running turn, or `interrupt`
 * restarts the turn with it. It tells the agent a live question it closed is unanswered (a
 * message-mode one stays open: don't ask twice), a cancelled Claude tool call was this message, a
 * settled thread is unsettled. A delivery asking nothing is a notice, so a pending settle survives.
 */
import {
  CommandId,
  MessageId,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRunning, isSettled, shortId } from "./T4Threads.ts";

export class T4DeliveryError extends Schema.TaggedError<T4DeliveryError>()("T4DeliveryError", {
  message: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface T4DeliverInput {
  readonly target: OrchestrationV2ThreadShell;
  readonly text: string;
  readonly senderThreadId?: ThreadId;
  readonly interrupt?: boolean;
  /** Skip the delivery notes (the server's own relays). */
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

export const OPEN_QUESTION_NOTE = (questions: ReadonlyArray<string>) =>
  "Your question to the user is still open and they can answer it: " +
  questions.map((q) => `"${q}"`).join("; ") +
  ". This message is NOT their answer. Handle this message; don't ask the question again " +
  "(their answer will arrive as a message) unless this message changes what you need to ask.";

export const CANCELLED_TOOL_NOTE =
  'If a tool call of yours was just cancelled ("the user doesn\'t want to proceed"), this ' +
  "message cancelled it - not the user. The user has not asked you to stop; re-run it if you " +
  "still need it and carry on.";

export const REOPENED_SETTLED_NOTE =
  "Your thread was settled; this message reopened it, so it is no longer settled. Handle " +
  "the message, and if your work is still fully closed afterwards (nothing owed, nothing " +
  "awaiting the user), settle again as the last act of this turn.";

/** The delivery notes that apply to a target, as the message's prefix. */
export const deliveryNotes = (input: {
  readonly settled: boolean;
  readonly questions: ReadonlyArray<string>;
  /** Message-mode questions: still answerable whatever this message does. */
  readonly openQuestions?: ReadonlyArray<string>;
  readonly claudeRunning: boolean;
}): ReadonlyArray<string> => [
  ...(input.settled ? [REOPENED_SETTLED_NOTE] : []),
  ...(input.questions.length > 0 ? [UNANSWERED_QUESTION_NOTE(input.questions)] : []),
  ...((input.openQuestions ?? []).length > 0
    ? [OPEN_QUESTION_NOTE(input.openQuestions ?? [])]
    : []),
  ...(input.claudeRunning ? [CANCELLED_TOOL_NOTE] : []),
];

const make = Effect.gen(function* () {
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const store = yield* T4Store.T4Store;
  const ledger = yield* T4Ledger.T4Ledger;
  const config = yield* T4Config.T4ServerConfig;
  const crypto = yield* SecureRandom.SecureRandom;
  const uuid = crypto.uuidV4().pipe(Effect.orDie);

  const fail = (message: string) => (cause: unknown) => new T4DeliveryError({ message, cause });

  /**
   * Questions the target is still waiting on the user for: `live` ones an
   * incoming message can close, `open` (message-mode) ones it cannot.
   */
  const noQuestions = { live: [] as ReadonlyArray<string>, open: [] as ReadonlyArray<string> };
  const pendingQuestions = (target: OrchestrationV2ThreadShell) =>
    target.pendingRuntimeRequest?.kind !== "user_input"
      ? Effect.succeed(noQuestions)
      : threadManagement
          .getProjectThreadRecords(
            { projectId: target.projectId, threadId: target.id },
            ["runtimeRequests", "turnItems"],
            // Only question items: a release manager's whole history is 200+ MB.
            { turnItemTypes: ["user_input_request"] },
          )
          .pipe(
            Effect.map((records) => {
              const pending = new Map(
                records.runtimeRequests
                  .filter(
                    (request) => request.kind === "user_input" && request.status === "pending",
                  )
                  .map((request) => [request.id as string, request.responseCapability.type]),
              );
              const questionsWhere = (open: boolean) =>
                records.turnItems.flatMap((item) =>
                  item.type === "user_input_request" &&
                  pending.has(item.requestId) &&
                  (pending.get(item.requestId) === "message") === open
                    ? item.questions.map((question) => question.question || question.header)
                    : [],
                );
              return { live: questionsWhere(false), open: questionsWhere(true) };
            }),
            Effect.orElseSucceed(() => noQuestions),
          );

  /** The delivery notes, prepended when they apply. */
  const withNotes = Effect.fn("t4.T4Delivery.withNotes")(function* (
    target: OrchestrationV2ThreadShell,
    text: string,
  ) {
    const questions = yield* pendingQuestions(target);
    const notes = deliveryNotes({
      settled: isSettled(target),
      questions: questions.live,
      openQuestions: questions.open,
      claudeRunning: target.providerInstanceId.startsWith("claude") && isRunning(target),
    });
    return notes.length === 0
      ? text
      : `${notes.map((note) => `(Thread tools: ${note})`).join("\n\n")}\n\n${text}`;
  });

  const decorate: T4DeliveryShape["decorate"] = Effect.fn("t4.T4Delivery.decorate")(function* (
    input: Parameters<T4DeliveryShape["decorate"]>[0],
  ) {
    if (input.target.archivedAt !== null) {
      return yield* new T4DeliveryError({
        message: `"${input.target.title}" is archived - its work is closed; start a new thread instead`,
      });
    }
    const header = `Message from thread "${input.sender.title}" (${shortId(input.sender.id)}):\n\n`;
    return yield* withNotes(input.target, header + input.text);
  });

  const deliver: T4DeliveryShape["deliver"] = Effect.fn("t4.T4Delivery.deliver")(function* (
    input: Parameters<T4DeliveryShape["deliver"]>[0],
  ) {
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
