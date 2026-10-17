/**
 * t4 fork: t4's own database, `<userdata>/t4.sqlite`, beside T3's state
 * database. Keeping t4's tables out of T3's file leaves T3's schema,
 * migrations and planner statistics untouched (extra tables shared
 * `PRAGMA optimize`'s analysis budget), and makes rolling the fork back a
 * matter of ignoring one file. Provided only to T4Store, so every other
 * service keeps T3's SqlClient.
 */
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import { runT4Migrations } from "./T4Migrations.ts";

const layerSetup = Layer.effectDiscard(
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`PRAGMA journal_mode = WAL;`;
    yield* sql`PRAGMA busy_timeout = 5000;`;
    yield* runT4Migrations();
  }),
);

export const layerFromPath = (dbPath: string) =>
  Layer.provideMerge(layerSetup, NodeSqliteClient.layer({ filename: dbPath }));

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const { dbPath } = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    const fs = yield* FileSystem.FileSystem;
    const dir = path.dirname(dbPath);
    yield* fs.makeDirectory(dir, { recursive: true });
    return layerFromPath(path.join(dir, "t4.sqlite"));
  }),
);

export const layerMemory = layerFromPath(":memory:");
