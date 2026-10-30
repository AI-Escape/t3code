/**
 * t4 fork: every t4 service, for the server to provide once.
 */
import * as Layer from "effect/Layer";

import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Settle from "./T4Settle.ts";
import * as T4Sql from "./T4Sql.ts";
import * as T4Store from "./T4Store.ts";

export const layer = Layer.merge(T4Settle.layer, T4RunWatch.layer).pipe(
  Layer.provideMerge(T4Delivery.layer),
  Layer.provideMerge(T4Ledger.layer),
  // T4Store gets t4's own database; nothing else sees that SqlClient.
  Layer.provideMerge(T4Store.layer.pipe(Layer.provide(T4Sql.layer))),
  Layer.provideMerge(T4Config.layer),
);
