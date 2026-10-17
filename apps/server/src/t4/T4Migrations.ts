/**
 * t4 fork: schema for t4's session tooling (handoff ledger, release managers,
 * linked issues, wakes, settle requests).
 *
 * These migrations keep their own ledger table, `t4_sql_migrations`, never
 * T3's `effect_sql_migrations`: the migrator skips every id at or below the
 * highest it has recorded, so a fork migration under an id upstream later
 * uses would mask that upstream migration forever
 * (docs/internals/legacy-orchestration-migration.md).
 */
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

const T4_MIGRATIONS_TABLE = "t4_sql_migrations";

const Migration0001 = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One open entry per (from, to): a follow-up to a thread that already owes
  // the sender an answer updates that entry instead of opening a second debt.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_handoffs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      from_thread_id TEXT NOT NULL,
      from_title TEXT NOT NULL,
      to_thread_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT,
      settled_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS t4_handoffs_open_to
      ON t4_handoffs (to_thread_id) WHERE settled_at IS NULL
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS t4_handoffs_open_from
      ON t4_handoffs (from_thread_id) WHERE settled_at IS NULL
  `;
  // Deliveries that ask nothing of their recipient: a pending settle survives them.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_notices (
      message_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_release_managers (
      project_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_issue_links (
      thread_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      identifier TEXT NOT NULL,
      url TEXT,
      title TEXT,
      linked_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, provider, identifier)
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS t4_issue_links_identifier
      ON t4_issue_links (provider, identifier)
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_wakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id TEXT NOT NULL,
      thread_title TEXT NOT NULL,
      by_thread_id TEXT NOT NULL,
      note TEXT NOT NULL,
      schedule_json TEXT NOT NULL,
      due TEXT NOT NULL,
      created_at TEXT NOT NULL,
      fired INTEGER NOT NULL DEFAULT 0
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS t4_wakes_due ON t4_wakes (due)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_settle_requests (
      thread_id TEXT PRIMARY KEY,
      requested_at TEXT NOT NULL
    ) WITHOUT ROWID
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_stalls (
      thread_id TEXT NOT NULL,
      at TEXT NOT NULL
    )
  `;
  // Markers such as the one-time import of the old JSON state.
  yield* sql`
    CREATE TABLE IF NOT EXISTS t4_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID
  `;
});

const t4MigrationEntries = [[1, "T4SessionTooling", Migration0001]] as const;

const run = Migrator.make({});

/** Runs pending t4 migrations; called right after T3's own `runMigrations`. */
export const runT4Migrations = Effect.fn("runT4Migrations")(function* () {
  const executed = yield* run({
    loader: Migrator.fromRecord(
      Object.fromEntries(t4MigrationEntries.map(([id, name, m]) => [`${id}_${name}`, m])),
    ),
    table: T4_MIGRATIONS_TABLE,
  });
  if (executed.length > 0) {
    yield* Effect.log("t4 migrations ran").pipe(
      Effect.annotateLogs({ migrations: executed.map(([id, name]) => `${id}_${name}`) }),
    );
  }
  return executed;
});
