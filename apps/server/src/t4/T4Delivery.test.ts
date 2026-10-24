import { assert, describe, it } from "@effect/vitest";

import {
  CANCELLED_TOOL_NOTE,
  deliveryNotes,
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
});
