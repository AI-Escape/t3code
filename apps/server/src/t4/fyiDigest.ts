/**
 * t4 fork: "no reply needed" handoffs from one thread to another arrive at
 * most every ten minutes, bundled.
 *
 * ai-escape's AI-27 PM received 762 messages in a week - 377 fyi handoffs,
 * many of them progress narration from its release manager and children -
 * and compacted nine times (2026-10-29). A pure fyi (no `done`, no `ask`)
 * that follows the sender's last fyi to the same thread within the window is
 * queued; a job delivers each queue as one message once the window has
 * passed. Anything that answers or asks is delivered at once, as before.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Store from "./T4Store.ts";
import { shortId } from "./T4Threads.ts";

export const FYI_WINDOW_MS = 10 * 60_000;
const INDEX_KEY = "fyi-digest-pairs";
const lastKey = (from: string, to: string) => `fyi-last:${from}:${to}`;
const queueKey = (from: string, to: string) => `fyi-queue:${from}:${to}`;

const Pair = Schema.Struct({ from: Schema.String, to: Schema.String, fromTitle: Schema.String });
const Item = Schema.Struct({ at: Schema.Number, body: Schema.String });
const Pairs = Schema.fromJsonString(Schema.Array(Pair));
const Items = Schema.fromJsonString(Schema.Array(Item));

const readPairs = (store: T4Store.T4StoreShape) =>
  store.meta(INDEX_KEY).pipe(
    Effect.flatMap((text) =>
      text === undefined ? Effect.succeed([]) : Schema.decodeEffect(Pairs)(text),
    ),
    Effect.orElseSucceed((): ReadonlyArray<typeof Pair.Type> => []),
  );
const readItems = (store: T4Store.T4StoreShape, key: string) =>
  store.meta(key).pipe(
    Effect.flatMap((text) =>
      text === undefined ? Effect.succeed([]) : Schema.decodeEffect(Items)(text),
    ),
    Effect.orElseSucceed((): ReadonlyArray<typeof Item.Type> => []),
  );
const writePairs = (store: T4Store.T4StoreShape, pairs: ReadonlyArray<typeof Pair.Type>) =>
  Schema.encodeEffect(Pairs)(pairs).pipe(Effect.flatMap((text) => store.setMeta(INDEX_KEY, text)));
const writeItems = (
  store: T4Store.T4StoreShape,
  key: string,
  items: ReadonlyArray<typeof Item.Type>,
) => Schema.encodeEffect(Items)(items).pipe(Effect.flatMap((text) => store.setMeta(key, text)));

/** When the sender's last fyi to this thread went out, or undefined if never. */
const lastSent = (store: T4Store.T4StoreShape, from: string, to: string) =>
  store.meta(lastKey(from, to)).pipe(
    Effect.map((text) => (text === undefined ? undefined : Number(text))),
    Effect.orElseSucceed(() => undefined),
  );

/**
 * Queues this fyi when the sender's last one to `to` went out within the
 * window; returns whether it was queued (else the caller delivers it and
 * calls `noteDelivered`).
 */
export const queueIfRecent = Effect.fn("t4.fyiDigest.queueIfRecent")(
  function* (input: {
    readonly from: string;
    readonly fromTitle: string;
    readonly to: string;
    readonly body: string;
  }) {
    const store = yield* T4Store.T4Store;
    const now = yield* Clock.currentTimeMillis;
    const last = yield* lastSent(store, input.from, input.to);
    if (last === undefined || now - last >= FYI_WINDOW_MS) return false;
    const key = queueKey(input.from, input.to);
    yield* writeItems(store, key, [
      ...(yield* readItems(store, key)),
      { at: now, body: input.body },
    ]);
    const pairs = yield* readPairs(store);
    if (!pairs.some((p) => p.from === input.from && p.to === input.to)) {
      yield* writePairs(store, [
        ...pairs,
        { from: input.from, to: input.to, fromTitle: input.fromTitle },
      ]);
    }
    return true;
  },
  Effect.orElseSucceed(() => false),
);

export const noteDelivered = Effect.fn("t4.fyiDigest.noteDelivered")(function* (
  from: string,
  to: string,
) {
  const store = yield* T4Store.T4Store;
  yield* store.setMeta(lastKey(from, to), String(yield* Clock.currentTimeMillis));
}, (effect) => Effect.ignore(effect));

/** The bundled message: the same HANDOFF header, every queued update in order. */
export const digestText = (
  fromTitle: string,
  from: string,
  items: ReadonlyArray<{ readonly body: string }>,
) =>
  `HANDOFF from "${fromTitle}" (${shortId(from)}) — no reply needed · ${items.length} updates, bundled:\n\n` +
  items.map((item) => item.body.trim()).join("\n\n---\n\n");

/** Delivers each queue whose window has passed. */
export const sweep = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const pairs = yield* readPairs(store);
  if (pairs.length === 0) return;
  const now = yield* Clock.currentTimeMillis;
  const kept: Array<typeof Pair.Type> = [];
  for (const pair of pairs) {
    const last = yield* lastSent(store, pair.from, pair.to);
    if (last !== undefined && now - last < FYI_WINDOW_MS) {
      kept.push(pair);
      continue;
    }
    const items = yield* readItems(store, queueKey(pair.from, pair.to));
    yield* writeItems(store, queueKey(pair.from, pair.to), []);
    if (items.length === 0) continue;
    const target = yield* threads
      .getThreadShell(ThreadId.make(pair.to))
      .pipe(Effect.orElseSucceed(() => null));
    if (target === null || target.deletedAt !== null || target.archivedAt !== null) continue;
    yield* delivery
      .deliver({
        target,
        text: digestText(pair.fromTitle, pair.from, items),
        senderThreadId: ThreadId.make(pair.from),
        notice: true,
      })
      .pipe(Effect.ignore);
    yield* store.setMeta(lastKey(pair.from, pair.to), String(now));
  }
  yield* writePairs(store, kept);
}).pipe(Effect.ignoreCause({ log: true }));
