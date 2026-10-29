/**
 * t4 fork: a thread's standing in t4's session tooling, for thread reads
 * (`t3_thread_list`, `t3_thread_read`, the operator API): its t4 state,
 * whether it is a release manager, what it owes and is owed, and the issues
 * it has linked.
 */
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { stateOf } from "./T4Threads.ts";

export interface T4ThreadFacts {
  readonly state: string;
  readonly isReleaseManager: boolean;
  readonly owes: number;
  readonly owedBy: number;
  readonly issues: ReadonlyArray<string>;
}

export const factsFor = Effect.fn("t4.factsFor")(function* (threadIds: ReadonlyArray<string>) {
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const now = yield* Clock.currentTimeMillis;
  const world = yield* ledger.world();
  const links = yield* store.issueLinks();
  const facts = new Map<string, T4ThreadFacts>();
  for (const id of threadIds) {
    const thread = world.byId.get(id);
    if (thread === undefined) continue;
    const f = ledger.facts(world, id);
    facts.set(id, {
      state: stateOf(thread, now),
      isReleaseManager: f.isReleaseManager,
      owes: f.owes,
      owedBy: f.owedBy,
      issues: links.filter((link) => link.threadId === id).map((link) => link.identifier),
    });
  }
  return facts;
});

/** The facts, or an empty map when the t4 services are absent or fail. */
export const optionalFactsFor = Effect.fn("t4.T4Facts.optionalFactsFor")(function* (threadIds: ReadonlyArray<string>) {
  const ledger = yield* Effect.serviceOption(T4Ledger.T4Ledger);
  const store = yield* Effect.serviceOption(T4Store.T4Store);
  if (ledger._tag === "None" || store._tag === "None") return new Map<string, T4ThreadFacts>();
  return yield* factsFor(threadIds).pipe(
    Effect.provideService(T4Ledger.T4Ledger, ledger.value),
    Effect.provideService(T4Store.T4Store, store.value),
    Effect.orElseSucceed(() => new Map<string, T4ThreadFacts>()),
  );
});
