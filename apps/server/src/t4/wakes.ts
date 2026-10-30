/**
 * t4 fork: a scheduled task posted into a thread is a wake. t4's rules for
 * them (behaviour contract: `cmd_wake`/`tick_wakes` in t4's `t3agents.py`):
 * at most 8 pending per thread, one-shots at most 30 days out, intervals at
 * least 5 minutes, and each run arrives as "WAKE (scheduled …)" with a
 * reminder on recurring ones to cancel it when the work is done.
 */
export const MAX_WAKES_PER_THREAD = 8;
export const MAX_ONE_SHOT_MS = 30 * 86_400_000;
export const MIN_WAKE_INTERVAL_MS = 5 * 60_000;

export type WakeSchedule =
  | { readonly type: "once"; readonly at: string }
  | { readonly type: "once"; readonly delayMs: number }
  | { readonly type: "interval"; readonly everyMs: number }
  | { readonly type: "cron"; readonly expression: string }
  | { readonly type: "fixed_time"; readonly timeOfDay: string }
  | { readonly type: "webhook" };

export const MAX_WAKE_NOTE_CHARS = 2000;

/**
 * A wake's note is read by the user too, and it was being used as storage:
 * usa-rs's release manager rewrote a 10-30 KB queue into it every 10 minutes
 * (3.4 MB of wake messages in a week, 2026-10-29).
 */
export function wakeNoteRefusal(note: string): string | undefined {
  return note.length <= MAX_WAKE_NOTE_CHARS
    ? undefined
    : `A wake note is at most ${MAX_WAKE_NOTE_CHARS} characters (this one is ${note.length}). Keep your state in a notes file (e.g. ~/artifacts/<your thread>/notes.md) and have the note say what to check and point to that file.`;
}

/** Why this wake breaks t4's rules, or undefined. */
export function wakeRefusal(
  schedule: WakeSchedule,
  pendingForThread: number,
  nowMs: number,
): string | undefined {
  if (schedule.type === "webhook") return undefined;
  if (pendingForThread >= MAX_WAKES_PER_THREAD) {
    return `that thread already has ${pendingForThread} pending wakes - cancel one first (list_scheduled_tasks, delete_scheduled_task)`;
  }
  if (schedule.type === "once") {
    const due = "delayMs" in schedule ? nowMs + schedule.delayMs : Date.parse(schedule.at);
    if (!Number.isFinite(due) || due <= nowMs) return "a one-shot wake needs a time in the future";
    if (due - nowMs > MAX_ONE_SHOT_MS) return "one-shot wakes can be at most 30 days out";
  }
  if (schedule.type === "interval" && schedule.everyMs < MIN_WAKE_INTERVAL_MS) {
    return "a recurring wake runs at most every 5 minutes";
  }
  return undefined;
}

/** The prompt a wake run posts: header, note, and the recurring reminder. */
export function wakePrompt(input: {
  readonly note: string;
  readonly scheduledAtLabel: string;
  readonly byTitle: string | undefined;
  readonly recurring: boolean;
}): string {
  const by = input.byTitle === undefined ? "" : ` by "${input.byTitle}"`;
  const footer = input.recurring
    ? "\n\n---\nRecurring - delete it (list_scheduled_tasks shows its id; delete_scheduled_task) in the turn that finishes this work."
    : "";
  return `WAKE (scheduled ${input.scheduledAtLabel}${by}):\n\n${input.note}${footer}`;
}
