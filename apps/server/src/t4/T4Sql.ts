/**
 * t4 fork: t4's own database, `<userdata>/t4.sqlite`, beside T3's, so T3's schema, migrations and
 * planner statistics stay untouched and rolling the fork back means ignoring one file. Provided
 * only to T4Store; every other service keeps T3's SqlClient.
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

const layerFromPath = (dbPath: string) =>
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
