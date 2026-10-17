/**
 * t4 fork: thread rules shared by t4's tools, read off V2 thread shells.
 * Each function names the `t3agents.py` function it replaces; that code is
 * the behaviour contract.
 */
import type { OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type T4ThreadState = "archived" | "running" | "waiting-you" | "settled" | "snoozed" | "idle";

type Shell = Pick<
  OrchestrationV2ThreadShell,
  | "id"
  | "title"
  | "status"
  | "activeRunId"
  | "archivedAt"
  | "deletedAt"
  | "settledOverride"
  | "settledAt"
  | "snoozedUntil"
  | "pendingRuntimeRequest"
  | "latestRunCompletedAt"
  | "latestRunRequestedAt"
  | "latestUserMessageAt"
  | "updatedAt"
  | "createdAt"
  | "branch"
  | "worktreePath"
>;

const ms = (value: DateTime.Utc | null | undefined) =>
  value == null ? null : DateTime.toEpochMillis(value);

/** `short()`: the 8-character id prefix agents and the dashboard show. */
export const shortId = (id: string) => (id.split(":").at(-1) ?? id).slice(0, 8);

/** `is_running()`: a run is under way (starting, running, or waiting on a tool/turn). */
export const isRunning = (t: Pick<Shell, "activeRunId" | "status">) =>
  t.activeRunId !== null ||
  t.status === "running" ||
  t.status === "starting" ||
  t.status === "preparing";

/** `is_settled()`: settled and not since taken back up. */
export const isSettled = (t: Pick<Shell, "settledOverride" | "settledAt">) =>
  t.settledOverride === "settled" || (t.settledOverride === null && t.settledAt !== null);

/** `is_retired()`. */
export const isRetired = (t: Pick<Shell, "archivedAt" | "settledOverride" | "settledAt">) =>
  t.archivedAt !== null || isSettled(t);

/** `state_of()`. */
export function stateOf(t: Shell, nowMs: number): T4ThreadState {
  if (t.archivedAt !== null) return "archived";
  if (isRunning(t)) return "running";
  if (t.pendingRuntimeRequest !== null) return "waiting-you";
  if (isSettled(t)) return "settled";
  const snoozed = ms(t.snoozedUntil ?? null);
  if (snoozed !== null && snoozed > nowMs) return "snoozed";
  return "idle";
}

/**
 * `last_activity()`: when the thread last did or received anything - its
 * latest run and message - not `updatedAt`, which T3 bumps on its own.
 */
export function lastActivityMs(t: Shell): number {
  const candidates = [
    ms(t.latestRunCompletedAt ?? null),
    ms(t.latestRunRequestedAt ?? null),
    ms(t.latestUserMessageAt),
  ].filter((value): value is number => value !== null);
  if (candidates.length > 0) return Math.max(...candidates);
  return Math.max(ms(t.updatedAt) ?? 0, ms(t.createdAt) ?? 0);
}

/** `where()`. */
export const whereOf = (t: Pick<Shell, "branch" | "worktreePath">) =>
  t.branch ?? (t.worktreePath !== null ? "worktree" : "main checkout");

/** `ago()`. */
export function ago(atMs: number, nowMs: number): string {
  const secs = Math.max(0, Math.floor((nowMs - atMs) / 1000));
  if (secs < 90) return `${secs}s`;
  if (secs < 5400) return `${Math.floor(secs / 60)}m`;
  if (secs < 172800) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

export type ResolveResult<T> =
  | { readonly type: "found"; readonly thread: T }
  | { readonly type: "none" }
  | { readonly type: "ambiguous"; readonly matches: ReadonlyArray<T> };

/**
 * `resolve()`: a thread from what an agent typed - full id, id prefix, short
 * id, exact title, or a unique title substring.
 */
export function resolveThreadRef<T extends Pick<Shell, "id" | "title" | "archivedAt">>(
  ref: string,
  threads: ReadonlyArray<T>,
  options: { readonly allowArchived?: boolean } = {},
): ResolveResult<T> {
  const wanted = ref.trim();
  const pool =
    options.allowArchived === false ? threads.filter((t) => t.archivedAt === null) : threads;
  const exact = pool.find((t) => t.id === wanted);
  if (exact !== undefined) return { type: "found", thread: exact };
  const prefixed = pool.filter(
    (t) => t.id.startsWith(wanted) || (t.id.split(":").at(-1) ?? t.id).startsWith(wanted),
  );
  if (prefixed.length === 1) return { type: "found", thread: prefixed[0]! };
  const low = wanted.toLowerCase();
  const exactTitle = pool.filter((t) => t.title.toLowerCase() === low);
  const titled =
    exactTitle.length > 0 ? exactTitle : pool.filter((t) => t.title.toLowerCase().includes(low));
  if (titled.length === 1) return { type: "found", thread: titled[0]! };
  const matches = prefixed.length > 0 ? prefixed : titled;
  return matches.length === 0 ? { type: "none" } : { type: "ambiguous", matches };
}

/** The issue id an agent's branch or title names (t4's `create_worktree` rule). */
export function issueIdIn(text: string | null | undefined): string | null {
  if (!text) return null;
  const match = /\b([a-z][a-z0-9]{0,9}-\d+)\b/i.exec(text);
  return match ? match[1]!.toUpperCase() : null;
}

/** `slug()`. */
export function slugOf(text: string, max = 32): string {
  const slug = text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return slug.slice(0, max).replace(/-+$/, "") || "task";
}
