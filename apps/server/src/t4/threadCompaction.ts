/**
 * t4 fork (AI-140): a compaction point per thread for standing roles and release managers,
 * filled by T4Roles every minute and read by the provider adapters at session start or resume.
 */

/** Claude Code compacts this many tokens short of its `autoCompactWindow`. */
const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

let table: ReadonlyMap<string, number> = new Map();

export const setThreadCompaction = (next: ReadonlyMap<string, number>): void => {
  table = next;
};

/** Tokens at which this thread's provider session should compact, if t4 set one. */
export const compactAtTokensFor = (threadId: string | null | undefined): number | undefined =>
  threadId === null || threadId === undefined ? undefined : table.get(threadId);

/** Claude's `autoCompactWindow` setting that makes it compact at `compactAt` tokens. */
export const claudeAutoCompactWindowFor = (compactAt: number): string =>
  String(Math.round(compactAt + CLAUDE_AUTO_COMPACT_RESERVE_TOKENS));
