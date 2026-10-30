/**
 * t4 fork: the handoff ledger and release-manager registry - who owes whom an
 * answer, and which thread is each project's release manager.
 *
 * Behaviour contract: `record_handoff`, `settle_owed`, `requester_closed`,
 * `rm_threads`, `find_rm` and `cmd_owed` in t4's `t3agents.py`.
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Store from "./T4Store.ts";
import { isRetired, isSettled, lastActivityMs } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

/**
 * `requester_closed()`: a debt is void once the thread that asked is settled,
 * archived or gone - nothing can act on the answer, and it must not block the
 * owner's settle.
 */
export function requesterClosed(
  entry: Pick<T4Store.T4Handoff, "fromThreadId">,
  byId: ReadonlyMap<string, Shell>,
): boolean {
  const from = byId.get(entry.fromThreadId);
  return (
    from === undefined || from.deletedAt !== null || from.archivedAt !== null || isSettled(from)
  );
}

/** Open entries that still bind someone. */
export function liveEntries(
  entries: ReadonlyArray<T4Store.T4Handoff>,
  byId: ReadonlyMap<string, Shell>,
): ReadonlyArray<T4Store.T4Handoff> {
  return entries.filter((entry) => entry.settledAt === null && !requesterClosed(entry, byId));
}

export interface T4ThreadLedgerFacts {
  readonly isReleaseManager: boolean;
  /** Live entries this thread owes (open handoffs to it). */
  readonly owes: number;
  /** Live entries owed to this thread (open handoffs from it). */
  readonly owedBy: number;
}

export interface T4World {
  readonly threads: ReadonlyArray<Shell>;
  readonly byId: ReadonlyMap<string, Shell>;
  readonly releaseManagers: ReadonlySet<string>;
  readonly open: ReadonlyArray<T4Store.T4Handoff>;
  readonly live: ReadonlyArray<T4Store.T4Handoff>;
}

export interface T4LedgerShape {
  /** Every thread (active and archived, deleted excluded) with the ledger. */
  readonly world: () => Effect.Effect<T4World, T4LedgerError>;
  readonly isReleaseManager: (world: T4World, thread: Pick<Shell, "id" | "title">) => boolean;
  /** `find_rm()`: the project's release manager, recording a title-matched one. */
  readonly findReleaseManager: (
    world: T4World,
    projectId: string,
    includeRetired: boolean,
  ) => Effect.Effect<Shell | undefined, T4LedgerError>;
  readonly facts: (world: T4World, threadId: string) => T4ThreadLedgerFacts;
}

export class T4LedgerError extends Schema.TaggedError<T4LedgerError>()("T4LedgerError", {
  cause: Schema.Defect(),
}) {
  override get message(): string {
    return "t4 ledger unavailable";
  }
}

export class T4Ledger extends Context.Service<T4Ledger, T4LedgerShape>()("t3/t4/T4Ledger") {}

export const make = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const config = yield* T4Config.T4ServerConfig;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const fail = (cause: unknown) => new T4LedgerError({ cause });

  const world: T4LedgerShape["world"] = Effect.fn("t4.T4Ledger.world")(function* () {
    const snapshot = yield* threadManagement.getShellSnapshot();
    const threads = [...snapshot.threads, ...snapshot.archivedThreads].filter(
      (thread) => thread.deletedAt === null,
    );
    const byId = new Map(threads.map((thread) => [thread.id as string, thread]));
    const rms = yield* store.releaseManagers();
    const open = yield* store.openHandoffs();
    return {
      threads,
      byId,
      releaseManagers: new Set(rms.values()),
      open,
      live: liveEntries(open, byId),
    };
  }, Effect.mapError(fail));

  // A fork of a release manager copies its title (" fork" added) and its pin,
  // but it is a copy: only the recorded thread, or a titled thread that is not
  // a fork, is one (usa-rs's "Release manager — usa-rs fork", made from the web
  // app's fork action, was badged and pinned as one, 2026-10-29).
  const titledReleaseManager = (thread: Pick<Shell, "title"> & Partial<Pick<Shell, "lineage">>) =>
    thread.title.startsWith(config.releaseManagerTitlePrefix) &&
    thread.lineage?.relationshipToParent !== "fork";

  const isReleaseManager: T4LedgerShape["isReleaseManager"] = (w, thread) =>
    w.releaseManagers.has(thread.id) ||
    titledReleaseManager({ ...thread, ...(w.byId.get(thread.id) ?? {}) });

  const findReleaseManager: T4LedgerShape["findReleaseManager"] = Effect.fn(
    "t4.T4Ledger.findReleaseManager",
  )(function* (
    w: Parameters<T4LedgerShape["findReleaseManager"]>[0],
    projectId: Parameters<T4LedgerShape["findReleaseManager"]>[1],
    includeRetired: Parameters<T4LedgerShape["findReleaseManager"]>[2],
  ) {
    const recorded = (yield* store.releaseManagers()).get(projectId);
    const known = recorded === undefined ? undefined : w.byId.get(recorded);
    if (known !== undefined && (includeRetired || !isRetired(known))) return known;
    const titled = w.threads
      .filter(
        (thread) =>
          thread.projectId === projectId &&
          titledReleaseManager(thread) &&
          (includeRetired || !isRetired(thread)),
      )
      .toSorted((left, right) => lastActivityMs(right) - lastActivityMs(left));
    const found = titled[0];
    if (found !== undefined) {
      yield* store.setReleaseManager(projectId, found.id);
    }
    return found;
  }, Effect.mapError(fail));

  const facts: T4LedgerShape["facts"] = (w, threadId) => {
    const thread = w.byId.get(threadId);
    return {
      isReleaseManager: thread !== undefined && isReleaseManager(w, thread),
      owes: w.live.filter((entry) => entry.toThreadId === threadId).length,
      owedBy: w.live.filter((entry) => entry.fromThreadId === threadId).length,
    };
  };

  return T4Ledger.of({ world, isReleaseManager, findReleaseManager, facts });
});

export const layer = Layer.effect(T4Ledger, make);
