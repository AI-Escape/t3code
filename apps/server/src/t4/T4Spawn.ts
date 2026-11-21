/**
 * t4 fork: what a launch adds to T3's, like t4's `cmd_spawn`. With no issue named it refuses while
 * other threads are live in the project unless `anyway`; named issues are checked by ownership
 * alone and linked. A parent gets a `spawn` ledger entry, the child's prompt a spawn footer. A
 * worktree launch into a non-git project is refused up front (upstream treats a git error as fine).
 */
import type { OrchestrationV2ThreadShell, ProjectId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ProcessRunner from "../processRunner.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { isRetired, isRunning, lastActivityMs, shortId, stateOf, whereOf } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

const LIVE_WINDOW_MS = 3 * 3600_000;

const normalizeIssue = (identifier: string) => identifier.trim().toUpperCase();

const COMMON_WORDS = new Set(
  "with from into that this when then than them they have make adds update thread work about after before more less only each does dont should still also fork".split(
    " ",
  ),
);
/** A title's distinctive words: issue ids and common words left out. */
export const titleKeywords = (title: string): ReadonlySet<string> =>
  new Set(
    (
      title
        .toLowerCase()
        .replace(/\b[a-z]+-\d+\b/g, " ")
        .match(/[a-z][a-z0-9]{3,}/g) ?? []
    ).filter((word) => !COMMON_WORDS.has(word)),
  );

/** The words two titles share, when they share enough to look like the same work. */
export const sharedKeywords = (left: string, right: string): ReadonlyArray<string> => {
  const a = titleKeywords(left);
  const b = titleKeywords(right);
  const shared = [...a].filter((word) => b.has(word));
  return shared.length >= 2 && shared.length * 2 >= Math.min(a.size, b.size) ? shared : [];
};

function spawnFooter(parent: Shell, parentIsReleaseManager: boolean): string {
  const ref = shortId(parent.id);
  return parentIsReleaseManager
    ? `\n\n---\nSpawned by the release manager (${ref}). When your approved PR is green, \`t3_handoff\` with done (no \`to\`) hands it the release and answers this spawn in one step. Blocked and need it to decide something: \`t3_handoff\` to "${ref}" with ask.`
    : `\n\n---\nSpawned by thread "${parent.title}" (${ref}). When the work is finished: \`t3_handoff\` to "${ref}" with done and fyi. Blocked and need it to decide something: \`t3_handoff\` to "${ref}" with ask.`;
}

/** Refusal text when a worktree can't be made in the project's folder. */
export const worktreeRefusal = Effect.fn("t4.worktreeRefusal")(function* (project: {
  readonly title: string;
  readonly workspaceRoot: string;
}) {
  const processes = yield* ProcessRunner.ProcessRunner;
  const isRepo = yield* processes
    .run({
      command: "git",
      args: ["-C", project.workspaceRoot, "rev-parse", "--is-inside-work-tree"],
      timeout: "15 seconds",
    })
    .pipe(
      Effect.map((out) => out.code === 0 && out.stdout.trim() === "true"),
      Effect.orElseSucceed(() => false),
    );
  return isRepo
    ? undefined
    : `project "${project.title}" (${project.workspaceRoot}) is not a git repository, so it can't hold a worktree - nothing was created. Launch in the repo's own project.`;
});

/** Refusal text, or the message to launch with. */
export const beforeLaunch = Effect.fn("t4.beforeLaunch")(function* (input: {
  readonly caller: Shell | undefined;
  readonly projectId: ProjectId;
  readonly issues: ReadonlyArray<string>;
  readonly anyway: boolean;
  readonly title: string;
  readonly message: string | undefined;
}) {
  const ledger = yield* T4Ledger.T4Ledger;
  const store = yield* T4Store.T4Store;
  const now = yield* Clock.currentTimeMillis;
  const world = yield* ledger.world();

  const live = world.threads.filter(
    (thread) =>
      thread.projectId === input.projectId &&
      !isRetired(thread) &&
      thread.id !== input.caller?.id &&
      !ledger.isReleaseManager(world, thread) &&
      thread.lineage.relationshipToParent !== "subagent" &&
      (isRunning(thread) || now - lastActivityMs(thread) < LIVE_WINDOW_MS),
  );
  if (input.caller !== undefined && !input.anyway && input.issues.length === 0) {
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

  // Naming an issue skips the live-thread guard, so a thread on the same work under another issue
  // still needs a word: the user relayed between such threads by hand (AI-125).
  if (input.caller !== undefined && !input.anyway && input.issues.length > 0) {
    const similar = live.flatMap((thread) => {
      const shared = sharedKeywords(input.title, thread.title);
      return shared.length === 0 ? [] : [{ thread, shared }];
    });
    if (similar.length > 0) {
      const listing = similar
        .slice(0, 5)
        .map(
          ({ thread, shared }) =>
            `  ${shortId(thread.id)}  ${thread.title} (shares: ${shared.join(", ")})`,
        )
        .join("\n");
      return {
        refused: `these live threads look like the same work - if one already owns it, message it instead.\n${listing}\nRe-run with anyway when the work is genuinely separate.`,
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
