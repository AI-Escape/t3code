/**
 * t4 fork (AI-140): a compaction point per thread. Standing roles and release
 * managers run in one long session each; usa-rs's release manager sent ~286k
 * tokens of context with every Codex request (3,172 requests, 2026-11-21..23)
 * because Codex compacts only near its 475k window. T4Roles fills this table
 * every minute; the provider adapters read it when a session starts or resumes.
 */

/** Claude Code compacts this many tokens short of its `autoCompactWindow`. */
export const CLAUDE_AUTO_COMPACT_RESERVE_TOKENS = 33_000;

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
