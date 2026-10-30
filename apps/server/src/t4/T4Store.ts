/**
 * t4 fork: storage for t4's session tooling (tables in T4Migrations.ts).
 *
 * The rules that decide what is written live in T4Ledger; this module only
 * reads and writes rows, so every caller (MCP tools, HTTP routes, jobs, the
 * legacy import) shares one copy of the persistence code.
 */
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

export type T4HandoffKind = "handoff" | "spawn";

export interface T4Handoff {
  readonly id: string;
  readonly kind: T4HandoffKind;
  readonly fromThreadId: string;
  readonly fromTitle: string;
  readonly toThreadId: string;
  readonly projectId: string;
  readonly summary: string;
  readonly createdAt: string;
  readonly updatedAt: string | null;
  readonly settledAt: string | null;
}

export interface T4IssueLink {
  readonly threadId: string;
  readonly provider: string;
  readonly identifier: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly linkedAt: string;
}

export type T4WakeSchedule =
  | { readonly kind: "at"; readonly spec: string }
  | { readonly kind: "in"; readonly spec: string }
  | { readonly kind: "every"; readonly spec: string; readonly seconds: number }
  | { readonly kind: "cron"; readonly spec: string };

export interface T4Wake {
  readonly id: number;
  readonly threadId: string;
  readonly threadTitle: string;
  readonly byThreadId: string;
  readonly note: string;
  readonly schedule: T4WakeSchedule;
  readonly due: string;
  readonly createdAt: string;
  readonly fired: number;
}

const MAX_NOTICES = 500;

type StoreError = SqlError.SqlError;

export interface T4StoreShape {
  readonly openHandoffs: () => Effect.Effect<ReadonlyArray<T4Handoff>, StoreError>;
  readonly allHandoffs: () => Effect.Effect<ReadonlyArray<T4Handoff>, StoreError>;
  /** Opens a (from, to) entry, or updates the summary of the one already open. */
  readonly recordHandoff: (input: {
    readonly kind: T4HandoffKind;
    readonly fromThreadId: string;
    readonly fromTitle: string;
    readonly toThreadId: string;
    readonly projectId: string;
    readonly summary: string;
    readonly at?: string;
  }) => Effect.Effect<{ readonly id: string; readonly updated: boolean }, StoreError>;
  /** Settles every open entry from `fromThreadId` to `toThreadId`; returns how many. */
  readonly settleHandoffs: (input: {
    readonly fromThreadId: string;
    readonly toThreadId: string;
  }) => Effect.Effect<number, StoreError>;
  readonly insertHandoffRow: (row: T4Handoff) => Effect.Effect<void, StoreError>;

  readonly addNotice: (messageId: string) => Effect.Effect<void, StoreError>;
  readonly noticeIds: (
    messageIds: ReadonlyArray<string>,
  ) => Effect.Effect<ReadonlySet<string>, StoreError>;

  readonly releaseManagers: () => Effect.Effect<ReadonlyMap<string, string>, StoreError>;
  readonly setReleaseManager: (
    projectId: string,
    threadId: string,
  ) => Effect.Effect<void, StoreError>;

  readonly issueLinks: (threadId?: string) => Effect.Effect<ReadonlyArray<T4IssueLink>, StoreError>;
  readonly issueLinksFor: (
    provider: string,
    identifier: string,
  ) => Effect.Effect<ReadonlyArray<T4IssueLink>, StoreError>;
  readonly linkIssue: (link: T4IssueLink) => Effect.Effect<boolean, StoreError>;
  readonly unlinkIssue: (input: {
    readonly threadId: string;
    readonly provider: string;
    readonly identifier: string;
  }) => Effect.Effect<boolean, StoreError>;

  readonly settleRequests: () => Effect.Effect<ReadonlyMap<string, string>, StoreError>;
  readonly setSettleRequest: (threadId: string, at: string) => Effect.Effect<void, StoreError>;
  readonly clearSettleRequest: (threadId: string) => Effect.Effect<void, StoreError>;

  readonly wakes: (threadId?: string) => Effect.Effect<ReadonlyArray<T4Wake>, StoreError>;
  readonly wake: (id: number) => Effect.Effect<T4Wake | undefined, StoreError>;
  readonly insertWake: (
    wake: Omit<T4Wake, "id"> & { readonly id?: number },
  ) => Effect.Effect<number, StoreError>;
  readonly updateWake: (wake: T4Wake) => Effect.Effect<void, StoreError>;
  readonly deleteWake: (id: number) => Effect.Effect<void, StoreError>;

  readonly recentStalls: (
    threadId: string,
    sinceIso: string,
  ) => Effect.Effect<ReadonlyArray<string>, StoreError>;
  readonly addStall: (threadId: string, at: string) => Effect.Effect<void, StoreError>;

  readonly meta: (key: string) => Effect.Effect<string | undefined, StoreError>;
  readonly setMeta: (key: string, value: string) => Effect.Effect<void, StoreError>;
}

export class T4Store extends Context.Service<T4Store, T4StoreShape>()("t3/t4/T4Store") {}

interface HandoffRow {
  readonly id: string;
  readonly kind: string;
  readonly from_thread_id: string;
  readonly from_title: string;
  readonly to_thread_id: string;
  readonly project_id: string;
  readonly summary: string;
  readonly created_at: string;
  readonly updated_at: string | null;
  readonly settled_at: string | null;
}

const handoffOf = (row: HandoffRow): T4Handoff => ({
  id: row.id,
  kind: row.kind === "spawn" ? "spawn" : "handoff",
  fromThreadId: row.from_thread_id,
  fromTitle: row.from_title,
  toThreadId: row.to_thread_id,
  projectId: row.project_id,
  summary: row.summary,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  settledAt: row.settled_at,
});

interface IssueRow {
  readonly thread_id: string;
  readonly provider: string;
  readonly identifier: string;
  readonly url: string | null;
  readonly title: string | null;
  readonly linked_at: string;
}

const issueOf = (row: IssueRow): T4IssueLink => ({
  threadId: row.thread_id,
  provider: row.provider,
  identifier: row.identifier,
  url: row.url,
  title: row.title,
  linkedAt: row.linked_at,
});

interface WakeRow {
  readonly id: number;
  readonly thread_id: string;
  readonly thread_title: string;
  readonly by_thread_id: string;
  readonly note: string;
  readonly schedule_json: string;
  readonly due: string;
  readonly created_at: string;
  readonly fired: number;
}

const wakeOf = (row: WakeRow): T4Wake => ({
  id: row.id,
  threadId: row.thread_id,
  threadTitle: row.thread_title,
  byThreadId: row.by_thread_id,
  note: row.note,
  schedule: JSON.parse(row.schedule_json) as T4WakeSchedule,
  due: row.due,
  createdAt: row.created_at,
  fired: row.fired,
});

export const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const newId = crypto.randomUUIDv4().pipe(
    Effect.orDie,
    Effect.map((uuid) => uuid.replaceAll("-", "").slice(0, 10)),
  );

  const openHandoffs: T4StoreShape["openHandoffs"] = () =>
    sql<HandoffRow>`SELECT * FROM t4_handoffs WHERE settled_at IS NULL ORDER BY created_at`.pipe(
      Effect.map((rows) => rows.map(handoffOf)),
    );

  const allHandoffs: T4StoreShape["allHandoffs"] = () =>
    sql<HandoffRow>`SELECT * FROM t4_handoffs ORDER BY created_at`.pipe(
      Effect.map((rows) => rows.map(handoffOf)),
    );

  const recordHandoff: T4StoreShape["recordHandoff"] = (input) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const at = input.at ?? (yield* nowIso);
        const open = yield* sql<{ readonly id: string }>`
          SELECT id FROM t4_handoffs
          WHERE from_thread_id = ${input.fromThreadId} AND to_thread_id = ${input.toThreadId}
            AND settled_at IS NULL
          LIMIT 1
        `;
        if (open[0] !== undefined) {
          yield* sql`
            UPDATE t4_handoffs SET summary = ${input.summary}, updated_at = ${at}
            WHERE id = ${open[0].id}
          `;
          return { id: open[0].id, updated: true };
        }
        const id = yield* newId;
        yield* sql`
          INSERT INTO t4_handoffs
            (id, kind, from_thread_id, from_title, to_thread_id, project_id, summary, created_at)
          VALUES (${id}, ${input.kind}, ${input.fromThreadId}, ${input.fromTitle},
                  ${input.toThreadId}, ${input.projectId}, ${input.summary}, ${at})
        `;
        return { id, updated: false };
      }),
    );

  const settleHandoffs: T4StoreShape["settleHandoffs"] = Effect.fn("t4.T4Store.settleHandoffs")(
    function* (input: Parameters<T4StoreShape["settleHandoffs"]>[0]) {
      const at = yield* nowIso;
      const rows = yield* sql<{ readonly id: string }>`
      UPDATE t4_handoffs SET settled_at = ${at}
      WHERE from_thread_id = ${input.fromThreadId} AND to_thread_id = ${input.toThreadId}
        AND settled_at IS NULL
      RETURNING id
    `;
      return rows.length;
    },
  );

  const insertHandoffRow: T4StoreShape["insertHandoffRow"] = (row) =>
    sql`
      INSERT OR IGNORE INTO t4_handoffs
        (id, kind, from_thread_id, from_title, to_thread_id, project_id, summary,
         created_at, updated_at, settled_at)
      VALUES (${row.id}, ${row.kind}, ${row.fromThreadId}, ${row.fromTitle}, ${row.toThreadId},
              ${row.projectId}, ${row.summary}, ${row.createdAt}, ${row.updatedAt},
              ${row.settledAt})
    `.pipe(Effect.asVoid);

  const addNotice: T4StoreShape["addNotice"] = Effect.fn("t4.T4Store.addNotice")(function* (
    messageId: Parameters<T4StoreShape["addNotice"]>[0],
  ) {
    const at = yield* nowIso;
    yield* sql`INSERT OR IGNORE INTO t4_notices (message_id, created_at) VALUES (${messageId}, ${at})`;
    yield* sql`
      DELETE FROM t4_notices WHERE message_id NOT IN (
        SELECT message_id FROM t4_notices ORDER BY created_at DESC LIMIT ${MAX_NOTICES}
      )
    `;
  });

  const noticeIds: T4StoreShape["noticeIds"] = (messageIds) =>
    messageIds.length === 0
      ? Effect.succeed(new Set<string>())
      : sql<{ readonly message_id: string }>`
          SELECT message_id FROM t4_notices WHERE ${sql.in("message_id", messageIds)}
        `.pipe(Effect.map((rows) => new Set(rows.map((row) => row.message_id))));

  const releaseManagers: T4StoreShape["releaseManagers"] = () =>
    sql<{ readonly project_id: string; readonly thread_id: string }>`
      SELECT project_id, thread_id FROM t4_release_managers
    `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.project_id, row.thread_id]))));

  const setReleaseManager: T4StoreShape["setReleaseManager"] = (projectId, threadId) =>
    sql`
      INSERT INTO t4_release_managers (project_id, thread_id) VALUES (${projectId}, ${threadId})
      ON CONFLICT (project_id) DO UPDATE SET thread_id = excluded.thread_id
    `.pipe(Effect.asVoid);

  const issueLinks: T4StoreShape["issueLinks"] = (threadId) =>
    (threadId === undefined
      ? sql<IssueRow>`SELECT * FROM t4_issue_links ORDER BY linked_at`
      : sql<IssueRow>`SELECT * FROM t4_issue_links WHERE thread_id = ${threadId} ORDER BY linked_at`
    ).pipe(Effect.map((rows) => rows.map(issueOf)));

  const issueLinksFor: T4StoreShape["issueLinksFor"] = (provider, identifier) =>
    sql<IssueRow>`
      SELECT * FROM t4_issue_links WHERE provider = ${provider} AND identifier = ${identifier}
      ORDER BY linked_at
    `.pipe(Effect.map((rows) => rows.map(issueOf)));

  const linkIssue: T4StoreShape["linkIssue"] = (link) =>
    sql<{ readonly identifier: string }>`
      INSERT INTO t4_issue_links (thread_id, provider, identifier, url, title, linked_at)
      VALUES (${link.threadId}, ${link.provider}, ${link.identifier}, ${link.url}, ${link.title},
              ${link.linkedAt})
      ON CONFLICT (thread_id, provider, identifier) DO NOTHING
      RETURNING identifier
    `.pipe(Effect.map((rows) => rows.length > 0));

  const unlinkIssue: T4StoreShape["unlinkIssue"] = (input) =>
    sql<{ readonly identifier: string }>`
      DELETE FROM t4_issue_links
      WHERE thread_id = ${input.threadId} AND provider = ${input.provider}
        AND identifier = ${input.identifier}
      RETURNING identifier
    `.pipe(Effect.map((rows) => rows.length > 0));

  const settleRequests: T4StoreShape["settleRequests"] = () =>
    sql<{ readonly thread_id: string; readonly requested_at: string }>`
      SELECT thread_id, requested_at FROM t4_settle_requests
    `.pipe(Effect.map((rows) => new Map(rows.map((row) => [row.thread_id, row.requested_at]))));

  const setSettleRequest: T4StoreShape["setSettleRequest"] = (threadId, at) =>
    sql`
      INSERT INTO t4_settle_requests (thread_id, requested_at) VALUES (${threadId}, ${at})
      ON CONFLICT (thread_id) DO UPDATE SET requested_at = excluded.requested_at
    `.pipe(Effect.asVoid);

  const clearSettleRequest: T4StoreShape["clearSettleRequest"] = (threadId) =>
    sql`DELETE FROM t4_settle_requests WHERE thread_id = ${threadId}`.pipe(Effect.asVoid);

  const wakes: T4StoreShape["wakes"] = (threadId) =>
    (threadId === undefined
      ? sql<WakeRow>`SELECT * FROM t4_wakes ORDER BY due`
      : sql<WakeRow>`SELECT * FROM t4_wakes WHERE thread_id = ${threadId} ORDER BY due`
    ).pipe(Effect.map((rows) => rows.map(wakeOf)));

  const wake: T4StoreShape["wake"] = (id) =>
    sql<WakeRow>`SELECT * FROM t4_wakes WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? undefined : wakeOf(rows[0]))),
    );

  const insertWake: T4StoreShape["insertWake"] = (w) =>
    (w.id === undefined
      ? sql<{ readonly id: number }>`
          INSERT INTO t4_wakes
            (thread_id, thread_title, by_thread_id, note, schedule_json, due, created_at, fired)
          VALUES (${w.threadId}, ${w.threadTitle}, ${w.byThreadId}, ${w.note},
                  ${JSON.stringify(w.schedule)}, ${w.due}, ${w.createdAt}, ${w.fired})
          RETURNING id
        `
      : sql<{ readonly id: number }>`
          INSERT OR IGNORE INTO t4_wakes
            (id, thread_id, thread_title, by_thread_id, note, schedule_json, due, created_at, fired)
          VALUES (${w.id}, ${w.threadId}, ${w.threadTitle}, ${w.byThreadId}, ${w.note},
                  ${JSON.stringify(w.schedule)}, ${w.due}, ${w.createdAt}, ${w.fired})
          RETURNING id
        `
    ).pipe(Effect.map((rows) => rows[0]?.id ?? w.id ?? 0));

  const updateWake: T4StoreShape["updateWake"] = (w) =>
    sql`
      UPDATE t4_wakes SET note = ${w.note}, schedule_json = ${JSON.stringify(w.schedule)},
        due = ${w.due}, fired = ${w.fired}, thread_title = ${w.threadTitle}
      WHERE id = ${w.id}
    `.pipe(Effect.asVoid);

  const deleteWake: T4StoreShape["deleteWake"] = (id) =>
    sql`DELETE FROM t4_wakes WHERE id = ${id}`.pipe(Effect.asVoid);

  const recentStalls: T4StoreShape["recentStalls"] = (threadId, sinceIso) =>
    sql<{ readonly at: string }>`
      SELECT at FROM t4_stalls WHERE thread_id = ${threadId} AND at >= ${sinceIso} ORDER BY at
    `.pipe(Effect.map((rows) => rows.map((row) => row.at)));

  const addStall: T4StoreShape["addStall"] = Effect.fn("t4.T4Store.addStall")(function* (
    threadId: Parameters<T4StoreShape["addStall"]>[0],
    at: Parameters<T4StoreShape["addStall"]>[1],
  ) {
    yield* sql`INSERT INTO t4_stalls (thread_id, at) VALUES (${threadId}, ${at})`;
    // Only the last day matters to the repeat window.
    yield* sql`DELETE FROM t4_stalls WHERE at < datetime(${at}, '-1 day')`;
  });

  const meta: T4StoreShape["meta"] = (key) =>
    sql<{ readonly value: string }>`SELECT value FROM t4_meta WHERE key = ${key}`.pipe(
      Effect.map((rows) => rows[0]?.value),
    );

  const setMeta: T4StoreShape["setMeta"] = (key, value) =>
    sql`
      INSERT INTO t4_meta (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `.pipe(Effect.asVoid);

  return T4Store.of({
    openHandoffs,
    allHandoffs,
    recordHandoff,
    settleHandoffs,
    insertHandoffRow,
    addNotice,
    noticeIds,
    releaseManagers,
    setReleaseManager,
    issueLinks,
    issueLinksFor,
    linkIssue,
    unlinkIssue,
    settleRequests,
    setSettleRequest,
    clearSettleRequest,
    wakes,
    wake,
    insertWake,
    updateWake,
    deleteWake,
    recentStalls,
    addStall,
    meta,
    setMeta,
  });
});

export const layer = Layer.effect(T4Store, make);
