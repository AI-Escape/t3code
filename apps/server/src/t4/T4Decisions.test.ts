import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import * as T4Decisions from "./T4Decisions.ts";

const layer = NodeSqliteClient.layer({ filename: ":memory:" });

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE orchestration_v2_projection_runtime_requests (
    runtime_request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT NOT NULL,
    kind TEXT NOT NULL, status TEXT NOT NULL, resolved_at TEXT, payload_json TEXT NOT NULL)`;
  yield* sql`CREATE TABLE orchestration_v2_projection_turn_items (
    turn_item_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, node_id TEXT,
    type TEXT NOT NULL, payload_json TEXT NOT NULL)`;
  const request = (
    id: string,
    threadId: string,
    status: string,
    resolvedAt: string | null,
    answers: Record<string, unknown>,
  ) =>
    sql`INSERT INTO orchestration_v2_projection_runtime_requests VALUES (${id}, ${threadId},
      ${`node:${id}`}, 'user_input', ${status}, ${resolvedAt},
      ${JSON.stringify({ id, kind: "user_input", status, resolvedAt, answers })})`;
  const item = (requestId: string, threadId: string, question: string, labels: string[]) =>
    sql`INSERT INTO orchestration_v2_projection_turn_items VALUES (${`item:${requestId}`},
      ${threadId}, ${`node:${requestId}`}, 'user_input_request', ${JSON.stringify({
        type: "user_input_request",
        requestId,
        questions: [{ id: "0", question, options: labels.map((label) => ({ label })) }],
      })})`;
  yield* request("r1", "t1", "resolved", "2026-11-01T10:00:00.000Z", { "0": "Merge" });
  yield* item("r1", "t1", "Merge it?", ["Merge", "Hold"]);
  yield* request("r2", "t1", "resolved", "2026-11-02T10:00:00.000Z", { "0": "only after QA" });
  yield* item("r2", "t1", "Ship today?", ["Yes", "No"]);
  yield* request("r3", "t2", "resolved", "2026-11-02T11:00:00.000Z", { "0": "Yes" });
  yield* item("r3", "t2", "Other thread", ["Yes"]);
  yield* request("old", "t1", "resolved", "2026-10-01T10:00:00.000Z", { "0": "Hold" });
  yield* request("open", "t1", "pending", null, {});
});

describe("T4Decisions.answeredQuestions", () => {
  it.effect("returns answers in the threads and window asked, with their questions", () =>
    Effect.gen(function* () {
      yield* setup;
      const answered = yield* T4Decisions.answeredQuestions(["t1"], "2026-10-20T00:00:00.000Z");
      const sorted = answered.toSorted((a, b) => a.resolvedAt.localeCompare(b.resolvedAt));
      assert.deepStrictEqual(
        sorted.map((entry) => [entry.threadId, entry.answer, entry.question?.question]),
        [
          ["t1", "Merge", "Merge it?"],
          ["t1", "only after QA", "Ship today?"],
        ],
      );
      assert.deepStrictEqual(
        sorted[0]?.question?.options?.map((option) => option.label),
        ["Merge", "Hold"],
      );
      assert.equal((yield* T4Decisions.answeredQuestions([], "2026-01-01")).length, 0);
    }).pipe(Effect.provide(layer)),
  );
});
