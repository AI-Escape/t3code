/**
 * t4 fork: every t4 service, for the server to provide once.
 */
import * as Layer from "effect/Layer";

import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";

export const layer = T4Delivery.layer.pipe(
  Layer.provideMerge(T4Ledger.layer),
  Layer.provideMerge(T4Store.layer),
  Layer.provideMerge(T4Config.layer),
);
