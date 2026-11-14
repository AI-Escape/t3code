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
  OPEN_QUESTION_NOTE,
  REOPENED_SETTLED_NOTE,
  UNANSWERED_QUESTION_NOTE,
} from "./T4Delivery.ts";

describe("deliveryNotes", () => {
  it("tells a settled thread the message reopened it", () => {
    assert.deepEqual(deliveryNotes({ settled: true, questions: [], claudeRunning: false }), [
      REOPENED_SETTLED_NOTE,
    ]);
  });

  it("adds nothing for an open, idle thread with no question", () => {
    assert.deepEqual(deliveryNotes({ settled: false, questions: [], claudeRunning: false }), []);
  });

  it("orders the reopened note before the question and cancelled-tool notes", () => {
    assert.deepEqual(
      deliveryNotes({ settled: true, questions: ["Ship it?"], claudeRunning: true }),
      [REOPENED_SETTLED_NOTE, UNANSWERED_QUESTION_NOTE(["Ship it?"]), CANCELLED_TOOL_NOTE],
    );
  });

  it("does not have a message-mode question asked again", () => {
    assert.deepEqual(
      deliveryNotes({
        settled: false,
        questions: [],
        openQuestions: ["Launch wave 2 now?"],
        claudeRunning: false,
      }),
      [OPEN_QUESTION_NOTE(["Launch wave 2 now?"])],
    );
    assert.notInclude(OPEN_QUESTION_NOTE(["Launch wave 2 now?"]), "ask the question again with");
  });
});

const CLAUDE = ProviderInstanceId.make("claudeAgent");
const running = {
  ...McpToolAccessTestkit.liveThreadShell(ThreadId.make("t4-target")),
  providerInstanceId: CLAUDE,
  modelSelection: { instanceId: CLAUDE, model: "claude-opus-5-5" },
};
const sent: Array<{ mode: string; text: string }> = [];
const deliveryLayer = T4Delivery.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(running),
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
      assert.deepEqual(
        sent.map((entry) => entry.mode),
        ["queue", "auto", "restart"],
      );
      assert.notInclude(sent[0]!.text, CANCELLED_TOOL_NOTE);
      assert.include(sent[1]!.text, CANCELLED_TOOL_NOTE);
      assert.include(patient.how, "waits until that turn ends");
      assert.equal(urgent.delivery, "steered");
      assert.equal(restart.delivery, "steered");
    }).pipe(Effect.provide(deliveryLayer)),
  );
});
