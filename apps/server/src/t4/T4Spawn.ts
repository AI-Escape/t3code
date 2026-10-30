/**
 * t4 fork: what a thread launch does on top of T3's - t4's `spawn`.
 *
 * Behaviour contract: `cmd_spawn` in t4's `t3agents.py`.
 *   - Live-thread guard: a thread spawning work that names no issue refuses
 *     while other threads are live in the project (running, or active in the
 *     last 3 hours; excluding itself and release managers) unless `anyway` -
 *     if one already owns the work, message it instead. A launch that names
 *     its issues is checked by issue ownership alone: on a busy project the
 *     list is never empty, and agents re-ran with `anyway` within seconds
 *     (usa-rs, 2026-10-30).
 *   - Issues: each is linked to the new thread; one an open thread already
 *     owns is refused unless `anyway`.
 *   - A parent thread gets a parent->child `spawn` ledger entry, and the
 *     child's prompt ends with the spawn footer (release-manager wording when
 *     the parent is one).
 */
import type { OrchestrationV2ThreadShell, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRetired, isRunning, lastActivityMs, shortId, stateOf, whereOf } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

const LIVE_WINDOW_MS = 3 * 3600_000;

export const normalizeIssue = (identifier: string) => identifier.trim().toUpperCase();

export function spawnFooter(parent: Shell, parentIsReleaseManager: boolean): string {
  const ref = shortId(parent.id);
  return parentIsReleaseManager
    ? `\n\n---\nSpawned by the release manager (${ref}). When your PR is green and has the merge word, \`t3_handoff\` with done (no \`to\`) hands it the release and answers this spawn in one step. Blocked and need it to decide something: \`t3_handoff\` to "${ref}" with ask.`
    : `\n\n---\nSpawned by thread "${parent.title}" (${ref}). When the work is finished: \`t3_handoff\` to "${ref}" with done and fyi. Blocked and need it to decide something: \`t3_handoff\` to "${ref}" with ask.`;
}

/** Refusal text, or the message to launch with. */
export const beforeLaunch = Effect.fn("t4.beforeLaunch")(function* (input: {
  readonly caller: Shell | undefined;
  readonly projectId: ProjectId;
  readonly issues: ReadonlyArray<string>;
  readonly anyway: boolean;
  readonly message: string | undefined;
}) {
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const now = yield* Clock.currentTimeMillis;
  const world = yield* ledger.world();

  if (input.caller !== undefined && !input.anyway && input.issues.length === 0) {
    const live = world.threads.filter(
      (thread) =>
        thread.projectId === input.projectId &&
        !isRetired(thread) &&
        thread.id !== input.caller?.id &&
        !ledger.isReleaseManager(world, thread) &&
        thread.lineage.relationshipToParent !== "subagent" &&
        (isRunning(thread) || now - lastActivityMs(thread) < LIVE_WINDOW_MS),
    );
    if (live.length > 0) {
      const listing = live
        .slice(0, 10)
        .map(
          (thread) =>
            `  ${shortId(thread.id)}  ${stateOf(thread, now).padEnd(11)} ${whereOf(thread).slice(0, 24).padEnd(24)} ${thread.title}`,
        )
        .join("\n");
      return {
        refused: `these threads are live in this project - if one already owns this work, message it instead.\n${listing}\nRe-run with anyway when the work is genuinely separate.`,
      } as const;
    }
  }

  for (const identifier of input.issues.map(normalizeIssue)) {
    const owner = (yield* store.issueLinksFor("linear", identifier))
      .map((link) => world.byId.get(link.threadId))
      .find((thread): thread is Shell => thread !== undefined && !isRetired(thread));
    if (owner !== undefined && !input.anyway) {
      return {
        refused: `${identifier} is owned by "${owner.title}" (${shortId(owner.id)}) - message that thread, or pass anyway`,
      } as const;
    }
  }

  const footer =
    input.caller === undefined
      ? ""
      : spawnFooter(input.caller, ledger.isReleaseManager(world, input.caller));
  return {
    message: input.message === undefined ? undefined : input.message + footer,
  } as const;
});

/** Links the issues and records the spawn. */
export const afterLaunch = Effect.fn("t4.afterLaunch")(function* (input: {
  readonly caller: Shell | undefined;
  readonly threadId: string;
  readonly projectId: string;
  readonly issues: ReadonlyArray<string>;
  readonly message: string | undefined;
}) {
  const store = yield* T4Store.T4Store;
  const linkedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  for (const identifier of input.issues.map(normalizeIssue)) {
    yield* store.linkIssue({
      threadId: input.threadId,
      provider: "linear",
      identifier,
      url: null,
      title: null,
      linkedAt,
    });
  }
  if (input.caller !== undefined) {
    yield* store.recordHandoff({
      kind: "spawn",
      fromThreadId: input.caller.id,
      fromTitle: input.caller.title,
      toThreadId: input.threadId,
      projectId: input.projectId,
      summary: ((input.message ?? "").split("\n")[0] ?? "").slice(0, 160),
    });
  }
});
