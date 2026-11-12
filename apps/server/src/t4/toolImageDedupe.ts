// t4 fork: strips the image copies stored before Read rows stopped keeping them
// (toolOutputImageBytes.ts). Design-review agents had left ~3.7 GB of them in usa-rs.
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { stripUnservedToolOutputImageBytes } from "../orchestration-v2/toolOutputImageBytes.ts";

const ItemJson = Schema.fromJsonString(Schema.Unknown);
const decodeItem = Schema.decodeUnknownSync(ItemJson);
const encodeItem = Schema.encodeSync(ItemJson);

// Rows carry images of up to ~1 MB; small pages keep each read and write short.
const PAGE_SIZE = 20;

export const stripViewedToolImageCopies = Effect.fn("T4ToolImageDedupe.strip")(function* (
  betweenPages: Effect.Effect<void> = Effect.void,
) {
  const sql = yield* SqlClient.SqlClient;
  let stripped = 0;
  let freedBytes = 0;
  for (let cursor = 0; ;) {
    const rows = yield* sql<{
      readonly row_id: number;
      readonly updated_at: string;
      readonly payload_json: string;
    }>`
      SELECT rowid AS row_id, updated_at, payload_json
      FROM orchestration_v2_projection_turn_items
      WHERE rowid > ${cursor}
        AND type = 'dynamic_tool'
        AND json_extract(payload_json, '$.viewedImagePath') IS NOT NULL
      ORDER BY rowid
      LIMIT ${PAGE_SIZE}
    `.pipe(NodeSqliteClient.readOnly);
    for (const row of rows) {
      // Only type, viewedImagePath and output are read, so the row is not decoded in full.
      const item = decodeItem(row.payload_json) as OrchestrationV2TurnItem;
      const next = stripUnservedToolOutputImageBytes(item);
      if (next === item) continue;
      const payload = encodeItem(next);
      // A newer write from the projector wins; it was already stripped on ingest.
      const updated = yield* sql<{ readonly row_id: number }>`
        UPDATE orchestration_v2_projection_turn_items SET payload_json = ${payload}
        WHERE rowid = ${row.row_id} AND updated_at = ${row.updated_at}
        RETURNING rowid AS row_id
      `;
      if (updated.length === 0) continue;
      stripped += 1;
      freedBytes += row.payload_json.length - payload.length;
    }
    yield* betweenPages;
    if (rows.length < PAGE_SIZE) break;
    cursor = rows.at(-1)?.row_id ?? cursor;
  }
  return { stripped, freedBytes };
});
