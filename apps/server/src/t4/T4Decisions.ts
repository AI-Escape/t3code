/**
 * t4 fork: the user's answers to ask-user questions, for `t3_decisions`, in
 * two indexed queries.
 *
 * The tool read them thread by thread (requests, then question items) through
 * the projection: ~190 threads per call on usa-rs, ~30 s of T3's one database
 * reader, and every new thread calls it (2026-11-02). A request and its
 * question item share a node id, which is indexed on both tables.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

export interface AnsweredQuestion {
  readonly threadId: string;
  readonly resolvedAt: string;
  readonly questionId: string;
  readonly answer: unknown;
  /** The question as asked, when its item was found. */
  readonly question:
    | {
        readonly question?: string | null | undefined;
        readonly header?: string | null | undefined;
        readonly options?: ReadonlyArray<{ readonly label: string }> | null | undefined;
      }
    | undefined;
}

const Text = Schema.optional(Schema.NullOr(Schema.String));
const decodeRequest = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      id: Text,
      answers: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.Unknown))),
    }),
  ),
);
const decodeItem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      requestId: Text,
      questions: Schema.optional(
        Schema.NullOr(
          Schema.Array(
            Schema.Struct({
              id: Schema.String,
              question: Text,
              header: Text,
              options: Schema.optional(
                Schema.NullOr(Schema.Array(Schema.Struct({ label: Schema.String }))),
              ),
            }),
          ),
        ),
      ),
    }),
  ),
);
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** Resolved user-input requests in `threadIds` answered at or after `sinceIso`. */
export const answeredQuestions = Effect.fn("t4.T4Decisions.answeredQuestions")(function* (
  threadIds: ReadonlyArray<string>,
  sinceIso: string,
) {
  if (threadIds.length === 0) return [] as ReadonlyArray<AnsweredQuestion>;
  const sql = yield* SqlClient.SqlClient;
  const ids = encodeIds(threadIds);
  const requests = yield* sql<{
    readonly thread_id: string;
    readonly node_id: string;
    readonly resolved_at: string;
    readonly payload_json: string;
  }>`
    SELECT thread_id, node_id, resolved_at, payload_json
    FROM orchestration_v2_projection_runtime_requests
    WHERE kind = 'user_input'
      AND status = 'resolved'
      AND resolved_at >= ${sinceIso}
      AND thread_id IN (SELECT value FROM json_each(${ids}))
  `.pipe(NodeSqliteClient.readOnly);
  if (requests.length === 0) return [] as ReadonlyArray<AnsweredQuestion>;
  const items = yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json
    FROM orchestration_v2_projection_turn_items
    WHERE type = 'user_input_request'
      AND node_id IN (SELECT value FROM json_each(${encodeIds(requests.map((row) => row.node_id))}))
  `.pipe(NodeSqliteClient.readOnly);
  const questionsByRequest = new Map<
    string,
    ReadonlyArray<NonNullable<AnsweredQuestion["question"]> & { readonly id: string }>
  >();
  for (const row of items) {
    const item = Option.getOrUndefined(decodeItem(row.payload_json));
    if (item?.requestId != null) questionsByRequest.set(item.requestId, item.questions ?? []);
  }
  const out: Array<AnsweredQuestion> = [];
  for (const row of requests) {
    const request = Option.getOrUndefined(decodeRequest(row.payload_json));
    if (request === undefined) continue;
    const questions = request.id == null ? [] : (questionsByRequest.get(request.id) ?? []);
    for (const [questionId, answer] of Object.entries(request.answers ?? {})) {
      out.push({
        threadId: row.thread_id,
        resolvedAt: row.resolved_at,
        questionId,
        answer,
        question: questions.find((question) => question.id === questionId),
      });
    }
  }
  return out as ReadonlyArray<AnsweredQuestion>;
});
