import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpToolAccessTestkit from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import {
  CANCELLED_TOOL_NOTE,
  deliveryNotes,
  REOPENED_SETTLED_NOTE,
  UNANSWERED_QUESTION_NOTE,
} from "./T4Delivery.ts";

describe("deliveryNotes", () => {
  it("tells a settled thread the message reopened it", () => {
    assert.deepEqual(deliveryNotes({ settled: true, questions: [], cutsApproval: false }), [
      REOPENED_SETTLED_NOTE,
    ]);
  });

  it("adds nothing for an open, idle thread with no question", () => {
    assert.deepEqual(deliveryNotes({ settled: false, questions: [], cutsApproval: false }), []);
  });

  it("orders the reopened note before the question and cancelled-tool notes", () => {
    assert.deepEqual(
      deliveryNotes({ settled: true, questions: ["Ship it?"], cutsApproval: true }),
      [REOPENED_SETTLED_NOTE, UNANSWERED_QUESTION_NOTE(["Ship it?"]), CANCELLED_TOOL_NOTE],
    );
  });
});

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const running = {
  ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("t4-target")),
  providerInstanceId: CLAUDE,
  modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
};
// Held on a command approval, which a steer cancels.
const approving = {
  ...running,
  id: ThreadId.make("t4-approving"),
  pendingRuntimeRequest: { id: "req-approval", kind: "command", createdAt: running.createdAt },
} as never;
const sent: Array<{ mode: string; text: string }> = [];
const deliveryLayer = T4Delivery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) =>
          Effect.succeed(threadId === ThreadId.make("t4-approving") ? approving : running),
        sendToThread: (input) =>
          Effect.sync(() => {
            sent.push({ mode: input.mode, text: input.text });
            return { delivery: input.mode === "queue" ? "queued" : "steered" } as never;
          }),
      }),
      Layer.mock(T4Store.T4Store)({ addNotice: () => Effect.void }),
      Layer.mock(T4Ledger.T4Ledger)({
        world: () => Effect.succeed({} as never),
        isReleaseManager: () => false,
        facts: () => Effect.die("unused"),
      } as never),
      Layer.succeed(T4Config.T4ServerConfig, T4Config.defaultT4ServerConfig),
      NodeCrypto.layer,
    ),
  ),
);

describe("deliver", () => {
  it.effect("queues a patient message behind a running turn, so no tool call is cut", () =>
    Effect.gen(function* () {
      sent.length = 0;
      const delivery = yield* T4Delivery.T4Delivery;
      const patient = yield* delivery.deliver({ target: running, text: "fyi", patient: true });
      const urgent = yield* delivery.deliver({ target: running, text: "done" });
      const restart = yield* delivery.deliver({
        target: running,
        text: "stop",
        patient: true,
        interrupt: true,
      });
      yield* delivery.deliver({ target: approving, text: "done" });
      assert.deepEqual(
        sent.map((entry) => entry.mode),
        ["queue", "auto", "restart", "auto"],
      );
      // Claude holds a steer until its command returns: only a pending approval is cut (AI-125).
      assert.notInclude(sent[0]!.text, CANCELLED_TOOL_NOTE);
      assert.notInclude(sent[1]!.text, CANCELLED_TOOL_NOTE);
      assert.include(sent[3]!.text, CANCELLED_TOOL_NOTE);
      assert.include(patient.how, "waits until that turn ends");
      assert.equal(urgent.delivery, "steered");
      assert.equal(restart.delivery, "steered");
    }).pipe(Effect.provide(deliveryLayer)),
  );
});

describe("question notes", () => {
  // A thread waiting on two questions: a message-mode card (Claude and Codex here) and a live one.
  const waiting = {
    ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("t4-waiting")),
    pendingRuntimeRequest: { id: "req-card", kind: "user_input" },
  } as never;
  const request = (id: string, type: string) => ({
    id,
    kind: "user_input",
    status: "pending",
    responseCapability: { type },
  });
  const item = (requestId: string, question: string) => ({
    type: "user_input_request",
    requestId,
    questions: [{ question, header: "" }],
  });
  const texts: Array<string> = [];
  const layer = T4Delivery.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(waiting),
          getProjectThreadRecords: () =>
            Effect.succeed({
              runtimeRequests: [request("req-card", "message"), request("req-live", "live")],
              turnItems: [
                item("req-card", "Anything to tune on the cover sheet?"),
                item("req-live", "Ship it?"),
              ],
            } as never),
          sendToThread: (input) =>
            Effect.sync(() => {
              texts.push(input.text);
              return { delivery: "started" } as never;
            }),
        }),
        Layer.mock(T4Store.T4Store)({ addNotice: () => Effect.void }),
        Layer.mock(T4Ledger.T4Ledger)({
          world: () => Effect.succeed({} as never),
          isReleaseManager: () => false,
          facts: () => Effect.die("unused"),
        } as never),
        Layer.succeed(T4Config.T4ServerConfig, T4Config.defaultT4ServerConfig),
        NodeCrypto.layer,
      ),
    ),
  );

  it.effect("names only a question the message can close, never an open card (AI-114)", () =>
    Effect.gen(function* () {
      texts.length = 0;
      const delivery = yield* T4Delivery.T4Delivery;
      yield* delivery.deliver({ target: waiting, text: "staging: PR #1 is on staging." });
      assert.lengthOf(texts, 1);
      assert.include(texts[0]!, UNANSWERED_QUESTION_NOTE(["Ship it?"]));
      assert.notInclude(texts[0]!, "Anything to tune");
      assert.notInclude(texts[0]!, "still open");
    }).pipe(Effect.provide(layer)),
  );
});
