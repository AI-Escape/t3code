/**
 * t4 fork (AI-143): wake a thread when a customer, supplier or staff member answers it. The thread
 * names who it waits on and a check - any shell command that prints the reply once it exists and
 * nothing before (`email replies --since ... --from ...`, usa-rs's `usars chat ... replies --since
 * ...`) - and t4 runs the check itself on an interval, at no AI cost, posting one message when it
 * prints something or when the deadline passes. Before this a thread waiting on Dolma's answer in
 * usa-rs's issue chat scheduled three wakes to look (2026-11-23), each a turn, and sat on the
 * dashboard looking idle while it asked the user "Anything else?". Watches live in t4_meta;
 * `/api/t4/state` lists them so the dashboard shows "Waiting on Dolma".
 */
import { ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Store from "./T4Store.ts";

const META_KEY = "reply-watches";
const MAX_PER_THREAD = 5;
/** A check that fails this many times in a row ends the watch with a note. */
const MAX_FAILURES = 5;
const OUTPUT_CAP = 8_000;
export const MIN_EVERY_MS = 60_000;
export const MAX_EVERY_MS = 60 * 60_000;
export const MAX_DEADLINE_MS = 14 * 86_400_000;

const Watch = Schema.Struct({
  threadId: Schema.String,
  who: Schema.String,
  about: Schema.NullOr(Schema.String),
  check: Schema.String,
  /** How the check reaches them, for the dashboard ("email", "usa-rs chat", ...). */
  via: Schema.NullOr(Schema.String),
  cwd: Schema.NullOr(Schema.String),
  since: Schema.Number,
  deadline: Schema.Number,
  everyMs: Schema.Number,
  lastCheck: Schema.Number,
  failures: Schema.Number,
  lastError: Schema.NullOr(Schema.String),
});
export type Watch = typeof Watch.Type;
const Watches = Schema.fromJsonString(Schema.Array(Watch));
const decodeWatches = Schema.decodeUnknownEffect(Watches);
const encodeWatches = Schema.encodeEffect(Watches);

export class T4ReplyWatchError extends Schema.TaggedError<T4ReplyWatchError>()(
  "T4ReplyWatchError",
  { message: Schema.String },
) {}

const PACIFIC = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  weekday: "short",
  hour: "numeric",
  minute: "2-digit",
});
/** "Mon 2:40 PM PT" - the user reads these notes, and the user reads Pacific (AI-142). */
export const pacific = (ms: number) => `${PACIFIC.format(ms)} PT`;

/** "90s", "5m", "1h", "2d" (or a bare number of minutes) to milliseconds. */
export const parseDuration = (text: string): number | null => {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(s|m|min|h|d|w)?\s*$/i.exec(text);
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  const scale =
    unit === "s"
      ? 1_000
      : unit === "h"
        ? 3_600_000
        : unit === "d"
          ? 86_400_000
          : unit === "w"
            ? 604_800_000
            : 60_000;
  return Math.round(n * scale);
};

/** One check a minute while the wait is short (staff answer within the hour), five after. */
export const defaultEvery = (deadlineMs: number) =>
  deadlineMs <= 3 * 3_600_000 ? MIN_EVERY_MS : 5 * MIN_EVERY_MS;

const clip = (text: string, cap: number) =>
  text.length > cap ? `${text.slice(0, cap)}\n[cut at ${cap.toLocaleString()} characters]` : text;

const label = (w: Watch) => `${w.who}${w.about ? ` (${w.about})` : ""}`;

export const replyMessage = (w: Watch, output: string) =>
  [
    `REPLY from ${label(w)} - your wait_for_reply check found it:`,
    "",
    clip(output.trim(), OUTPUT_CAP),
    "",
    "The watch has ended. Act on the reply now; to wait for another answer, call wait_for_reply again.",
  ].join("\n");

export const deadlineMessage = (w: Watch) =>
  [
    `NO REPLY from ${label(w)} by ${pacific(w.deadline)} (asked ${pacific(w.since)}); the watch has ended.`,
    `Check: \`${w.check}\``,
    "Decide what's next: follow up with them and wait again, or bring it to the user as a card (wait longer, or go ahead without the answer).",
  ].join("\n");

export const failingMessage = (w: Watch) =>
  [
    `The wait_for_reply check for ${label(w)} failed ${MAX_FAILURES} times in a row, so the watch has ended.`,
    `Check: \`${w.check}\``,
    `Last error: ${clip(w.lastError ?? "(no output)", 600)}`,
    "Fix the command (run it yourself first) and call wait_for_reply again.",
  ].join("\n");

export interface T4ReplyWatchShape {
  /** Starts (or replaces: same thread and `who`) a watch. */
  readonly watch: (input: {
    readonly threadId: string;
    readonly who: string;
    readonly about: string | null;
    readonly check: string;
    readonly via: string | null;
    readonly cwd: string | null;
    readonly deadlineMs: number;
    readonly everyMs: number;
  }) => Effect.Effect<{ readonly watch: Watch; readonly replaced: boolean }, T4ReplyWatchError>;
  /** Ends a thread's watches - one by `who`, or all of them. */
  readonly cancel: (threadId: string, who: string | null) => Effect.Effect<ReadonlyArray<Watch>>;
  readonly sweep: Effect.Effect<void>;
  readonly watches: Effect.Effect<ReadonlyArray<Watch>>;
}

export class T4ReplyWatch extends Context.Service<T4ReplyWatch, T4ReplyWatchShape>()(
  "t3/t4/T4ReplyWatch",
) {}

const sameWho = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const make = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const delivery = yield* T4Delivery.T4Delivery;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const processes = yield* ProcessRunner.ProcessRunner;
  const lock = yield* Semaphore.make(1);

  const load = store.meta(META_KEY).pipe(
    Effect.flatMap((text) => (text === undefined ? Effect.succeed([]) : decodeWatches(text))),
    Effect.orElseSucceed((): ReadonlyArray<Watch> => []),
  );
  const save = (list: ReadonlyArray<Watch>) =>
    encodeWatches(list).pipe(
      Effect.flatMap((text) => store.setMeta(META_KEY, text)),
      Effect.ignore,
    );

  const watch: T4ReplyWatchShape["watch"] = Effect.fn("t4.T4ReplyWatch.watch")(function* (input) {
    const now = yield* Clock.currentTimeMillis;
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const all = yield* load;
        const mine = all.filter((w) => w.threadId === input.threadId);
        const replaced = mine.some((w) => sameWho(w.who, input.who));
        if (!replaced && mine.length >= MAX_PER_THREAD) {
          return yield* new T4ReplyWatchError({
            message: `this thread already waits on ${MAX_PER_THREAD} people (${mine.map((w) => w.who).join(", ")}); cancel one first`,
          });
        }
        const next: Watch = {
          threadId: input.threadId,
          who: input.who,
          about: input.about,
          check: input.check,
          via: input.via,
          cwd: input.cwd,
          since: now,
          deadline: now + input.deadlineMs,
          everyMs: input.everyMs,
          // The first check runs at the next sweep.
          lastCheck: 0,
          failures: 0,
          lastError: null,
        };
        yield* save([
          ...all.filter((w) => !(w.threadId === input.threadId && sameWho(w.who, input.who))),
          next,
        ]);
        return { watch: next, replaced };
      }),
    );
  });

  const cancel: T4ReplyWatchShape["cancel"] = (threadId, who) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const all = yield* load;
        const gone = all.filter(
          (w) => w.threadId === threadId && (who === null || sameWho(w.who, who)),
        );
        if (gone.length > 0) yield* save(all.filter((w) => !gone.includes(w)));
        return gone;
      }),
    );

  const runCheck = (w: Watch) =>
    processes
      .run({
        command: "bash",
        // BASH_ENV (/etc/t4-env.sh) loads the client's keys and t4's helpers.
        args: ["-c", w.check],
        ...(w.cwd === null ? {} : { cwd: w.cwd }),
        timeout: "90 seconds",
        timeoutBehavior: "timedOutResult",
      })
      .pipe(
        Effect.map((result) =>
          result.timedOut
            ? ({ kind: "failed", error: "the check ran past 90 seconds" } as const)
            : result.code !== 0
              ? ({
                  kind: "failed",
                  error:
                    `exit ${result.code}: ${(result.stderr || result.stdout).trim()}`.slice(0, 600),
                } as const)
              : result.stdout.trim().length > 0
                ? ({ kind: "reply", output: result.stdout } as const)
                : ({ kind: "none" } as const),
        ),
        Effect.catch((cause) => Effect.succeed({ kind: "failed", error: String(cause) } as const)),
      );

  /** Gone, archived or settled: nobody to wake, and a message would reopen a settled thread. */
  const liveTarget = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.map((target) =>
        target === null ||
        target.deletedAt !== null ||
        target.archivedAt !== null ||
        target.settledOverride === "settled" ||
        target.settledAt != null
          ? null
          : target,
      ),
      Effect.orElseSucceed(() => null),
    );

  const post = (threadId: string, text: string) =>
    liveTarget(threadId).pipe(
      Effect.flatMap((target) =>
        target === null
          ? Effect.void
          : delivery
              .deliver({
                target,
                text,
                force: true,
                // Waits for a running turn to end instead of cutting its command.
                patient: true,
                createdBy: "system",
                creationSource: "server",
              })
              .pipe(Effect.asVoid),
      ),
      Effect.ignore,
    );

  const sweep: T4ReplyWatchShape["sweep"] = Effect.gen(function* () {
    const list = yield* load;
    if (list.length === 0) return;
    const now = yield* Clock.currentTimeMillis;
    const ended = new Set<Watch>();
    const updated = new Map<Watch, Watch>();
    for (const w of list) {
      if ((yield* liveTarget(w.threadId)) === null) {
        ended.add(w);
        continue;
      }
      if (now - w.lastCheck < w.everyMs && now < w.deadline) continue;
      const result = yield* runCheck(w);
      if (result.kind === "reply") {
        ended.add(w);
        yield* post(w.threadId, replyMessage(w, result.output));
        yield* Effect.logInfo("t4.reply-watch-replied", {
          threadId: w.threadId,
          who: w.who,
          waitedMinutes: Math.round((now - w.since) / 60_000),
        });
        continue;
      }
      if (result.kind === "failed" && w.failures + 1 >= MAX_FAILURES) {
        ended.add(w);
        yield* post(w.threadId, failingMessage({ ...w, lastError: result.error }));
        yield* Effect.logWarning("t4.reply-watch-failing", {
          threadId: w.threadId,
          who: w.who,
          error: result.error,
        });
        continue;
      }
      if (now >= w.deadline) {
        ended.add(w);
        yield* post(w.threadId, deadlineMessage(w));
        yield* Effect.logInfo("t4.reply-watch-deadline", { threadId: w.threadId, who: w.who });
        continue;
      }
      updated.set(w, {
        ...w,
        lastCheck: now,
        failures: result.kind === "failed" ? w.failures + 1 : 0,
        lastError: result.kind === "failed" ? result.error : null,
      });
    }
    if (ended.size === 0 && updated.size === 0) return;
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // Re-read: a watch started or cancelled while the checks ran stays as the tool left it.
        const latest = yield* load;
        const key = (w: Watch) => `${w.threadId}\u0000${w.who.toLowerCase()}\u0000${w.since}`;
        const endedKeys = new Set([...ended].map(key));
        const updates = new Map([...updated].map(([before, after]) => [key(before), after]));
        yield* save(
          latest
            .filter((w) => !endedKeys.has(key(w)))
            .map((w) => updates.get(key(w)) ?? w),
        );
      }),
    );
  }).pipe(Effect.ignoreCause({ log: true }));

  return T4ReplyWatch.of({ watch, cancel, sweep, watches: load });
});

export const layer = Layer.effect(T4ReplyWatch, make);
