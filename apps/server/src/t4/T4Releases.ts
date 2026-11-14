/**
 * t4 fork: what release managers, owners and waiters are told about the release queue, so none
 * of them polls it: a release manager's handoffs and wakes carry its queue and debts.
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { ago, isRetired, shortId } from "./T4Threads.ts";

type Row = T4Store.T4ReleaseRow;

const LISTED = 8;

/** When the row reached its current state. */
const stateSinceOf = (row: Row): string => {
  switch (row.state) {
    case "queued":
      return row.queuedAt;
    case "merged":
      return row.mergedAt ?? row.updatedAt;
    case "staging":
      return row.stagedAt ?? row.updatedAt;
    case "shipped":
      return row.shippedAt ?? row.updatedAt;
    default:
      return row.updatedAt;
  }
};

/**
 * The one-paragraph header a release manager gets with every handoff and run-watch wake: what is
 * open in its queue and how many threads it owes an answer, so it starts a turn without reading
 * either.
 */
const releaseManagerBrief = (
  rows: ReadonlyArray<Row>,
  owed: ReadonlyArray<{ readonly fromTitle: string }>,
  nowMs: number,
): string => {
  const open = rows.filter((row) => row.state !== "shipped");
  const listed = open
    .slice(0, LISTED)
    .map(
      (row) =>
        `#${row.pr} ${row.state} ${ago(Date.parse(stateSinceOf(row)), nowMs)}${row.note ? ` (${row.note.slice(0, 60)})` : ""}`,
    );
  const more = open.length > LISTED ? `, +${open.length - LISTED} more` : "";
  const queue =
    open.length === 0
      ? "Your queue is empty."
      : `Your queue: ${open.length} open - ${listed.join(", ")}${more}.`;
  const owes =
    owed.length === 0
      ? "You owe no thread an answer."
      : `You owe ${owed.length} thread${owed.length === 1 ? "" : "s"} an answer: ${owed
          .slice(0, LISTED)
          .map((entry) => `"${entry.fromTitle.slice(0, 50)}"`)
          .join(", ")}${owed.length > LISTED ? ", …" : ""}.`;
  return `(t4: ${queue} ${owes} This is current - read \`release_queue\` or \`t3_owed\` only for detail.)\n\n`;
};

/** The release manager's brief, read fresh. Empty when the store can't be read. */
export const releaseManagerBriefFor = Effect.fn("t4.releaseManagerBriefFor")(function* (
  rm: { readonly id: string; readonly projectId: string },
  world: T4Ledger.T4World,
  /** The thread whose request this brief rides on, counted even before it is recorded. */
  asking?: { readonly id: string; readonly title: string },
) {
  const store = yield* T4Store.T4Store;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* store
    .releaseQueue({ projectId: rm.projectId })
    .pipe(Effect.orElseSucceed(() => null));
  if (rows === null) return "";
  const owed: Array<{ readonly fromTitle: string }> = world.live.filter(
    (entry) => entry.toThreadId === rm.id,
  );
  if (
    asking !== undefined &&
    !world.live.some((entry) => entry.toThreadId === rm.id && entry.fromThreadId === asking.id)
  ) {
    owed.push({ fromTitle: asking.title });
  }
  return releaseManagerBrief(rows, owed, now);
});

/** A queue row as release_queue returns it by default: ~200 bytes. */
export const compactEntry = (
  row: Row,
  world: T4Ledger.T4World,
  nowMs: number,
  lastReadAt: string | undefined,
) => {
  const owner = row.ownerThreadId === null ? undefined : world.byId.get(row.ownerThreadId);
  return {
    pr: row.pr,
    state: row.state,
    since: ago(Date.parse(stateSinceOf(row)), nowMs),
    title: row.title === null ? null : row.title.slice(0, 80),
    issue: row.issue,
    owner:
      row.ownerThreadId === null
        ? null
        : `${(owner?.title ?? row.ownerTitle ?? row.ownerThreadId).slice(0, 60)} (${shortId(row.ownerThreadId)}${owner === undefined ? ", deleted" : ""})`,
    note: row.note,
    commit: row.commitSha === null ? null : row.commitSha.slice(0, 10),
    changed: lastReadAt === undefined || row.updatedAt > lastReadAt,
  };
};

/** One release notice per owner and state (release_queue). */
export const releaseNotice = (
  state: "staging" | "shipped" | "failed",
  prs: ReadonlyArray<number>,
  note: string | null,
) => {
  const list = prs.map((pr) => `#${pr}`).join(", ");
  const plural = prs.length === 1 ? "PR" : "PRs";
  switch (state) {
    case "staging":
      // 45 settles were refused on `staging:` in a week (AI-93): the owner still owes verification.
      return `staging: ${plural} ${list} ${prs.length === 1 ? "is" : "are"} on staging. Verify there. Don't settle yet: \`shipped:\` comes when ${prs.length === 1 ? "it is" : "they are"} live.${note ? ` ${note}` : ""}`;
    case "shipped":
      return `shipped: ${plural} ${list} live in production. Verify, close your Linear.${note ? ` ${note}` : ""}`;
    case "failed":
      return `release failed on your ${plural} ${list}: ${note ?? "see the release manager's thread"}`;
  }
};

/** What a thread waiting on someone else's PR hears (AI-93). */
export const waiterNotice = (
  state: "staging" | "shipped" | "failed",
  row: Pick<Row, "pr" | "title" | "note">,
  projectTitle: string,
) => {
  const what = `PR #${row.pr}${row.title ? ` ("${row.title.slice(0, 80)}")` : ""} in ${projectTitle}`;
  switch (state) {
    case "staging":
      return `release: ${what}, which you are waiting on, is on staging. You hear again when it is live.`;
    case "shipped":
      return `release: ${what}, which you were waiting on, is live in production. You are no longer waiting on it.`;
    case "failed":
      return `release: ${what}, which you are waiting on, failed to release${row.note ? ` (${row.note})` : ""}. Its owner is fixing it; you hear again when it ships.`;
  }
};

const STALE_MS = 2 * 60 * 60_000;
const pingedKey = (row: Row) => `release-ping:${row.projectId}:${row.pr}`;

/** The note an owner gets when its PR has sat in one state for over 2 hours. */
const staleNotice = (row: Row, nowMs: number) =>
  `release: your PR #${row.pr} is still ${row.state} (for ${ago(Date.parse(stateSinceOf(row)), nowMs)})${row.note ? `: ${row.note}` : ""}. Nothing to do for it - the release manager sends \`shipped:\` when it is live; don't schedule a wake or read \`release_queue\` to check.`;

/**
 * Owners whose PR row has not changed for 2 hours hear where it is, once per change, so they
 * stop setting wakes to check for `shipped:` (783 of 840 owner wakes in 98 h, AI-93).
 */
export const sweepStale = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const now = yield* Clock.currentTimeMillis;
  const rows = yield* store.releaseQueue();
  for (const row of rows) {
    if (row.state === "shipped" || row.state === "failed" || row.ownerThreadId === null) continue;
    if (now - Date.parse(row.updatedAt) < STALE_MS) continue;
    const pinged = yield* store.meta(pingedKey(row)).pipe(Effect.orElseSucceed(() => undefined));
    if (pinged === row.updatedAt) continue;
    yield* store.setMeta(pingedKey(row), row.updatedAt);
    const owner = yield* threads
      .getThreadShell(ThreadId.make(row.ownerThreadId))
      .pipe(Effect.orElseSucceed(() => null));
    if (owner === null || isRetired(owner)) continue;
    yield* delivery
      .deliver({
        target: owner,
        text: staleNotice(row, now),
        force: true,
        patient: true,
        notice: true,
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.ignore);
  }
}).pipe(Effect.ignoreCause({ log: true }));
