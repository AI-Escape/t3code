/**
 * t4 fork: handlers for the session-tooling tools (tools.ts).
 * Each mirrors its `t3agents.py` command; messages to the agent keep the
 * CLI's wording where it carried a rule.
 */
import {
  CommandId,
  MessageId,
  OrchestratorMcpFailure,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as T4Config from "../../../t4/T4Config.ts";
import * as T4Decisions from "../../../t4/T4Decisions.ts";
import * as T4Delivery from "../../../t4/T4Delivery.ts";
import * as FyiDigest from "../../../t4/fyiDigest.ts";
import * as T4Ledger from "../../../t4/T4Ledger.ts";
import * as T4RunWatch from "../../../t4/T4RunWatch.ts";
import * as T4Store from "../../../t4/T4Store.ts";
import {
  ago,
  issueIdIn,
  isRetired,
  lastActivityMs,
  resolveThreadRef,
  shortId,
  stateOf,
  whereOf,
} from "../../../t4/T4Threads.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { T4Toolkit } from "./tools.ts";

type Shell = OrchestrationV2ThreadShell;

const invalid = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

const ledgerUnavailable = () => unavailable();

const summaryOf = (thread: Shell, nowMs: number) => ({
  threadId: thread.id,
  shortId: shortId(thread.id),
  title: thread.title,
  state: stateOf(thread, nowMs),
});

/** A thread by reference, with t4's ambiguity message. */
const resolveRef = (ref: string, world: T4Ledger.T4World) => {
  const found = resolveThreadRef(ref, world.threads);
  switch (found.type) {
    case "found":
      return Effect.succeed(found.thread);
    case "none":
      return Effect.fail(
        new OrchestratorMcpFailure({
          code: "thread_not_found",
          message: `no thread matches '${ref}' (see \`t3_thread_list\`)`,
        }),
      );
    case "ambiguous":
      return Effect.fail(
        invalid(
          `'${ref}' matches several threads - use an id:\n` +
            found.matches
              .slice(0, 8)
              .map((thread) => `  ${shortId(thread.id)}  ${thread.title}`)
              .join("\n"),
        ),
      );
  }
};

/** The calling thread; these tools act as a thread. */
const callerThread = Effect.gen(function* () {
  const { caller } = yield* readCaller();
  if (caller === undefined) {
    return yield* invalid("This tool acts as a T3 thread; call it from inside one.");
  }
  return caller;
});

const nowMs = Clock.currentTimeMillis;

/**
 * The user's latest word in an owner's thread - the last question they
 * answered and the last message they typed - for a handoff to the release
 * manager. It read the owner's thread to check the merge word on 117 of 136
 * reads, 5 MB in a day (usa-rs, 2026-10-30); now the handoff carries it.
 */
const latestUserWord = Effect.fn("t4.latestUserWord")(function* (me: Shell, now: number) {
  const { threads } = yield* readCaller();
  const records = yield* threads
    .getProjectThreadRecords(
      { projectId: me.projectId, threadId: me.id },
      ["messages", "runtimeRequests", "turnItems"],
      { messageRoles: ["user"], turnItemTypes: ["user_input_request"] },
    )
    .pipe(Effect.orElseSucceed(() => null));
  if (records === null) return "";
  const lines: Array<string> = [];
  const answered = records.runtimeRequests
    .filter(
      (request) =>
        request.kind === "user_input" &&
        request.status === "resolved" &&
        request.resolvedAt !== null,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.resolvedAt!) - DateTime.toEpochMillis(left.resolvedAt!),
    )[0];
  if (answered !== undefined && answered.resolvedAt !== null) {
    const item = records.turnItems.find(
      (candidate) => candidate.type === "user_input_request" && candidate.requestId === answered.id,
    );
    const questions = item?.type === "user_input_request" ? item.questions : [];
    for (const [questionId, raw] of Object.entries(answered.answers ?? {})) {
      const question = questions.find((q) => q.id === questionId);
      const answer = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
      const asked = (question?.question ?? question?.header ?? questionId)
        .replaceAll(/\s+/g, " ")
        .slice(0, 160);
      lines.push(
        `- answered "${asked}": "${answer.replaceAll(/\s+/g, " ").slice(0, 300)}" (${ago(DateTime.toEpochMillis(answered.resolvedAt), now)})`,
      );
    }
  }
  const typed = records.messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.createdBy === "user" &&
        message.senderThreadId === undefined &&
        message.scheduledTaskId === undefined,
    )
    .toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    )[0];
  if (typed !== undefined) {
    lines.push(
      `- typed: "${typed.text.replaceAll(/\s+/g, " ").slice(0, 300)}" (${ago(DateTime.toEpochMillis(typed.createdAt), now)})`,
    );
  }
  return lines.length === 0
    ? ""
    : `The user's latest word in this thread (from T3, not the sender):\n${lines.join("\n")}\n\n`;
});

/**
 * t4 fork: owners schedule a check for `shipped:`; 31 of 59 such wakes fired
 * after it had arrived (usa-rs, 2026-10-30). Name them so the owner deletes
 * the ones that were only for this release.
 */
const pendingWakesNote = Effect.fn("t4.pendingWakesNote")(function* (
  threadId: string,
  now: number,
) {
  const scheduled = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
  if (Option.isNone(scheduled)) return "";
  const { tasks } = yield* scheduled.value
    .list()
    .pipe(Effect.orElseSucceed(() => ({ tasks: [] as ReadonlyArray<never> })));
  const pending = tasks.filter(
    (task) =>
      task.threadId === threadId &&
      task.enabled &&
      task.schedule.type === "once" &&
      task.nextRunAt !== null &&
      Date.parse(String(task.nextRunAt)) > now,
  );
  if (pending.length === 0) return "";
  return (
    `\n\n---\nYour pending wake${pending.length === 1 ? "" : "s"}: ` +
    pending
      .slice(0, 5)
      .map((task) => `"${task.title}" (${task.id}, ${String(task.nextRunAt)})`)
      .join("; ") +
    ". Delete any that was only to check for this release (`delete_scheduled_task`)."
  );
});

const handoffHeader = (me: Shell, labels: ReadonlyArray<string>) =>
  `HANDOFF from "${me.title}" (${shortId(me.id)}, ${whereOf(me)}), ${labels.join(" · ")}:\n\n`;

/** The PR an owner's handoff names: a pull-request URL, else the first `#123`. */
export const prOfHandoff = (body: string): number | undefined => {
  const match = /\/pull\/(\d+)/.exec(body) ?? /(?:^|[^\w&])#(\d{1,6})\b/.exec(body);
  const pr = match === null ? Number.NaN : Number(match[1]);
  return Number.isInteger(pr) && pr > 0 ? pr : undefined;
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
      return `staging: ${plural} ${list} ${prs.length === 1 ? "is" : "are"} on staging. Verify there.${note ? ` ${note}` : ""}`;
    case "shipped":
      return `shipped: ${plural} ${list} live in production. Verify, close your Linear.${note ? ` ${note}` : ""}`;
    case "failed":
      return `release failed on your ${plural} ${list}: ${note ?? "see the release manager's thread"}`;
  }
};

const releaseEntryOf = (row: T4Store.T4ReleaseRow, world: T4Ledger.T4World, now: number) => {
  const owner = row.ownerThreadId === null ? undefined : world.byId.get(row.ownerThreadId);
  return {
    pr: row.pr,
    state: row.state,
    title: row.title,
    issue: row.issue,
    owner:
      owner !== undefined
        ? summaryOf(owner, now)
        : row.ownerThreadId === null
          ? null
          : {
              threadId: ThreadId.make(row.ownerThreadId),
              shortId: shortId(row.ownerThreadId),
              title: row.ownerTitle ?? row.ownerThreadId,
              state: "deleted",
            },
    commit: row.commitSha,
    note: row.note,
    queuedAt: row.queuedAt,
    mergedAt: row.mergedAt,
    stagedAt: row.stagedAt,
    shippedAt: row.shippedAt,
  };
};

const parseIssue = (input: {
  readonly identifier?: string | undefined;
  readonly url?: string | undefined;
}) => {
  const fromUrl = input.url === undefined ? null : issueIdIn(input.url.split("/issue/")[1] ?? "");
  const identifier = (input.identifier?.trim().toUpperCase() || fromUrl) ?? null;
  if (identifier === null || !/^[A-Z][A-Z0-9]{0,9}-\d+$/.test(identifier)) {
    return Effect.fail(invalid("Pass the issue identifier (e.g. USA-1234) or its URL."));
  }
  return Effect.succeed({ provider: "linear", identifier, url: input.url ?? null });
};

/** An owner's handoff to the release manager queues the PR it names (AI-71). */
const queueHandedOffPr = Effect.fn("t4.queueHandedOffPr")(function* (me: Shell, body: string) {
  const pr = prOfHandoff(body);
  if (pr === undefined) return undefined;
  const store = yield* T4Store.T4Store;
  yield* store
    .queueRelease({
      projectId: me.projectId,
      pr,
      ownerThreadId: me.id,
      ownerTitle: me.title,
      title: me.title,
      issue: issueIdIn(me.title) ?? undefined,
    })
    .pipe(Effect.ignoreCause({ log: true }));
  return pr;
});

export const layer = McpToolAccess.toLayer(T4Toolkit, {
  t3_handoff: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const delivery = yield* T4Delivery.T4Delivery;
      const config = yield* T4Config.T4ServerConfig;
      const projects = yield* Project.ProjectService;
      const now = yield* nowMs;
      const me = yield* callerThread;
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const project = Option.getOrUndefined(
        yield* projects.getById(me.projectId).pipe(Effect.mapError(unavailable)),
      );
      if (project === undefined) return yield* invalid("Your thread's project was not found.");
      const includeRetired = input.includeRetired === true;

      if (input.check === true) {
        const rm = yield* ledger
          .findReleaseManager(world, project.id, includeRetired)
          .pipe(Effect.mapError(ledgerUnavailable));
        return {
          to: rm === undefined ? null : summaryOf(rm, now),
          isReleaseManager: rm !== undefined,
          createdReleaseManager: false,
          delivery: null,
          settled: 0,
          nowOwesYou: false,
          youStillOweThem: false,
          notes: [
            rm === undefined
              ? "no release manager for this project"
              : `release manager: ${rm.title}`,
          ],
        };
      }

      let done = input.done === true;
      let ask = input.ask === true;
      let fyi = input.fyi === true;
      if (fyi && ask)
        return yield* invalid("`fyi` asks for nothing; `ask` asks for a reply - pick one");
      if (input.to !== undefined && !(done || ask || fyi)) {
        return yield* invalid(
          "say what this handoff does to the ledger:\n" +
            "  done   it answers what you owe them (settles their handoff to you)\n" +
            "  ask    they owe you a reply (`t3_owed` shows it on their side)\n" +
            "  fyi    neither - nothing settled, nothing asked\n" +
            "`done` combines with `ask` (finished, and now asking something new) or `fyi` (finished, nothing more).",
        );
      }
      if (input.to === undefined && fyi) {
        return yield* invalid(
          "a handoff to the release manager asks it to release - for information only, use `t3_thread_send`",
        );
      }
      const body = input.message?.trim() ?? "";
      if (body.length === 0) return yield* invalid("empty handoff: pass `message`");

      const notes: Array<string> = [];
      const meIsRm = ledger.isReleaseManager(world, me);
      let target: Shell | undefined;
      if (input.to !== undefined) {
        target = yield* resolveRef(input.to, world);
        if (target.id === me.id) return yield* invalid("that is this thread");
        if (ledger.isReleaseManager(world, target) && !meIsRm && !ask) {
          // Anything an owner hands the release manager is a release request.
          notes.push(
            "a handoff to the release manager always asks it to release - recorded as a request",
          );
          ask = true;
          fyi = false;
        }
      } else {
        if (meIsRm) {
          return yield* invalid(
            "you are the release manager - answer owners with `t3_handoff` and `to`",
          );
        }
        target = yield* ledger
          .findReleaseManager(world, project.id, includeRetired)
          .pipe(Effect.mapError(ledgerUnavailable));
        ask = true;
      }

      const labels = [
        ...(done ? ["answers your handoff"] : []),
        ask ? "reply expected" : "no reply needed",
      ];
      const toReleaseManager =
        !meIsRm && (target === undefined || ledger.isReleaseManager(world, target));
      const userWord = toReleaseManager ? yield* latestUserWord(me, now) : "";
      const header = handoffHeader(me, labels) + userWord;
      const footer = ask
        ? `\n\n---\nAnswer with \`t3_handoff\` (to: "${shortId(me.id)}", done: true; add fyi: true if you ask nothing back). \`t3_owed\` lists what you still owe.`
        : "";
      const summary = (body.split("\n")[0] ?? "").slice(0, 160);

      if (target === undefined) {
        // No release manager yet: start one with this handoff as its first turn.
        const crypto = yield* SecureRandom.SecureRandom;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const id = yield* crypto.uuidV4().pipe(Effect.orDie);
        const title = `${config.releaseManagerTitlePrefix}: ${project.title}`;
        const repo = project.workspaceRoot.split("/").filter(Boolean).at(-1) ?? project.title;
        const intro =
          `You are the release manager for ${project.title}: this project's one persistent release thread. ` +
          `Load the \`release-manager\` skill, and the repo's \`${repo}-release-manager\` skill if there is one, and ` +
          `follow them. You run in the main checkout and never archive or settle this thread.\n\n`;
        const modelSelection =
          config.releaseManagerModel ?? project.defaultModelSelection ?? me.modelSelection;
        const launched = yield* launches
          .launch({
            commandId: CommandId.make(`t4:rm:${id}`),
            threadId: ThreadId.make(`t4-rm-${id}`),
            projectId: project.id,
            title,
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            workspaceStrategy: { type: "root" },
            initialMessage: {
              messageId: MessageId.make(`t4:rm:${id}`),
              senderThreadId: me.id,
              text: intro + header + body + footer,
              attachments: [],
            },
            createdBy: "agent",
            creationSource: "mcp",
          })
          .pipe(Effect.mapError(unavailable));
        const rmId = launched.projection.thread.id;
        const threads = (yield* readCaller()).threads;
        yield* threads
          .dispatch({
            type: "thread.pin",
            commandId: CommandId.make(`t4:rm-pin:${id}`),
            threadId: rmId,
          })
          .pipe(Effect.ignore);
        yield* store.setReleaseManager(project.id, rmId).pipe(Effect.mapError(ledgerUnavailable));
        yield* store
          .recordHandoff({
            kind: "handoff",
            fromThreadId: me.id,
            fromTitle: me.title,
            toThreadId: rmId,
            projectId: project.id,
            summary,
          })
          .pipe(Effect.mapError(ledgerUnavailable));
        yield* queueHandedOffPr(me, body);
        notes.push(
          `no release manager for ${project.title} - started "${title}", pinned, and handed it this`,
        );
        const rmShell = yield* threads.getThreadShell(rmId).pipe(Effect.mapError(unavailable));
        return {
          to:
            rmShell === null
              ? { threadId: rmId, shortId: shortId(rmId), title, state: "running" }
              : summaryOf(rmShell, now),
          isReleaseManager: true,
          createdReleaseManager: true,
          delivery: "started",
          settled: 0,
          nowOwesYou: true,
          youStillOweThem: false,
          notes,
        };
      }

      const settled = done
        ? yield* store
            .settleHandoffs({ fromThreadId: target.id, toThreadId: me.id })
            .pipe(Effect.mapError(ledgerUnavailable))
        : 0;
      // An answer to a thread whose work is closed has no one to read it: the debt is void.
      if (done && !ask && isRetired(target)) {
        return {
          to: summaryOf(target, now),
          isReleaseManager: ledger.isReleaseManager(world, target),
          createdReleaseManager: false,
          delivery: null,
          settled,
          nowOwesYou: false,
          youStillOweThem: false,
          notes: [
            `"${target.title}" is ${target.archivedAt === null ? "settled" : "archived"} - its work is closed, so nothing was delivered and anything you owed it is void`,
          ],
        };
      }
      // t4 fork: a pure fyi soon after the last one to this thread is bundled (fyiDigest).
      const pureFyi = !done && !ask && input.interrupt !== true;
      if (
        pureFyi &&
        (yield* FyiDigest.queueIfRecent({
          from: me.id,
          fromTitle: me.title,
          to: target.id,
          body,
        }))
      ) {
        return {
          to: summaryOf(target, now),
          isReleaseManager: ledger.isReleaseManager(world, target),
          createdReleaseManager: false,
          delivery: "bundled",
          settled: 0,
          nowOwesYou: false,
          youStillOweThem: false,
          notes: [
            `bundled: "${target.title}" gets your no-reply-needed updates at most every 10 minutes, as one message - send fyi only for changes it acts on`,
          ],
        };
      }
      // t4 fork: owners schedule a check for `shipped:`; 31 of 59 such wakes
      // fired after it had arrived (usa-rs, 2026-10-30). Name them so the owner
      // deletes the ones that were only for this release.
      const wakesNote =
        meIsRm && done && !ledger.isReleaseManager(world, target)
          ? yield* pendingWakesNote(target.id, now)
          : "";
      const delivered = yield* delivery
        .deliver({
          target,
          text: header + body + footer + wakesNote,
          senderThreadId: me.id,
          interrupt: input.interrupt === true,
          notice: !ask,
        })
        .pipe(Effect.mapError((error) => invalid(error.message)));
      if (pureFyi) yield* FyiDigest.noteDelivered(me.id, target.id);
      if (ask) {
        yield* store
          .recordHandoff({
            kind: "handoff",
            fromThreadId: me.id,
            fromTitle: me.title,
            toThreadId: target.id,
            projectId: target.projectId,
            summary,
          })
          .pipe(Effect.mapError(ledgerUnavailable));
      }
      const targetIsRm = ledger.isReleaseManager(world, target);
      if (targetIsRm && !meIsRm) {
        const pr = yield* queueHandedOffPr(me, body);
        if (pr !== undefined) notes.push(`PR #${pr} is in the release manager's queue`);
      }
      if (done) {
        notes.push(
          settled > 0
            ? `settled ${settled} open handoff(s) from "${target.title}"`
            : `"${target.title}" had no open handoff to you - done settled nothing`,
        );
      }
      if (ask) notes.push(`"${target.title}" now owes you a reply (\`t3_owed\` with all)`);
      const youStillOweThem =
        !done &&
        world.live.some((entry) => entry.fromThreadId === target.id && entry.toThreadId === me.id);
      if (youStillOweThem) {
        notes.push(
          `you still owe "${target.title}" an answer - pass done on the handoff that finishes it`,
        );
      }
      return {
        to: summaryOf(target, now),
        isReleaseManager: targetIsRm,
        createdReleaseManager: false,
        delivery: delivered.how,
        settled,
        nowOwesYou: ask,
        youStillOweThem,
        notes,
      };
    }),
  ),

  t3_owed: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const now = yield* nowMs;
      const { caller } = yield* readCaller();
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      let entries = world.live;
      if (input.all === true || caller === undefined) {
        const projectId = input.projectId ?? caller?.projectId;
        entries =
          projectId === undefined ? entries : entries.filter((e) => e.projectId === projectId);
      } else {
        entries = entries.filter((entry) => entry.toThreadId === caller.id);
      }
      const describe = (id: string, title: string) => {
        const thread = world.byId.get(id);
        return thread === undefined
          ? { threadId: ThreadId.make(id), shortId: shortId(id), title, state: "deleted" }
          : summaryOf(thread, now);
      };
      return {
        entries: entries
          .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt))
          .map((entry) => ({
            id: entry.id,
            kind: entry.kind,
            from: describe(entry.fromThreadId, entry.fromTitle),
            to: describe(
              entry.toThreadId,
              world.byId.get(entry.toThreadId)?.title ?? entry.toThreadId,
            ),
            summary: entry.summary,
            createdAt: entry.createdAt,
            age: ago(Date.parse(entry.createdAt), now),
          })),
      };
    }),
  ),

  t3_decisions: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const now = yield* nowMs;
      const { caller } = yield* readCaller();
      const days = input.days ?? 14;
      const cutoffMs = now - days * 86_400_000;
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const scope = world.threads.filter(
        (thread) =>
          (input.all === true || caller === undefined || thread.projectId === caller.projectId) &&
          lastActivityMs(thread) >= cutoffMs,
      );
      const decisions: Array<{
        answeredAt: string;
        threadId: ThreadId;
        threadTitle: string;
        question: string;
        answer: string;
        isNote: boolean;
      }> = [];
      // Two indexed queries over every thread in scope (T4Decisions.ts). Read
      // thread by thread, ~190 threads held T3's one reader ~30 s a call and
      // stalled everything behind it (usa-rs, 2026-11-02).
      const byId = new Map(scope.map((thread) => [thread.id as string, thread]));
      const answered = yield* T4Decisions.answeredQuestions(
        [...byId.keys()],
        DateTime.formatIso(DateTime.makeUnsafe(cutoffMs)),
      ).pipe(Effect.orElseSucceed(() => []));
      for (const entry of answered) {
        const thread = byId.get(entry.threadId);
        if (thread === undefined) continue;
        const question = entry.question;
        const raw = entry.answer;
        const answer = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
        const labels = new Set((question?.options ?? []).map((option) => option.label));
        const picked = answer.split(",").map((part) => part.trim());
        decisions.push({
          answeredAt: entry.resolvedAt,
          threadId: thread.id,
          threadTitle: thread.title,
          question: (question?.question ?? question?.header ?? entry.questionId)
            .replaceAll(/\s+/g, " ")
            .slice(0, 160),
          answer: answer.replaceAll(/\s+/g, " "),
          isNote: !(labels.has(answer) || picked.every((part) => labels.has(part))),
        });
      }
      // Notes only unless asked: every new thread calls this, and with every
      // "Approve + merge when green" pick it returned ~160 KB (usa-rs,
      // 2026-10-30, 341 of 503 entries were picks).
      const needle = input.search?.trim().toLowerCase() ?? "";
      const seen = new Set<string>();
      const kept: typeof decisions = [];
      let omittedPicks = 0;
      let size = 0;
      let truncated = false;
      for (const entry of decisions.toSorted((left, right) =>
        right.answeredAt.localeCompare(left.answeredAt),
      )) {
        if (
          needle !== "" &&
          ![entry.question, entry.answer, entry.threadTitle].some((text) =>
            text.toLowerCase().includes(needle),
          )
        )
          continue;
        if (!entry.isNote && input.picks !== true) {
          omittedPicks += 1;
          continue;
        }
        const key = `${entry.question}\u0000${entry.answer}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const short = {
          ...entry,
          question: entry.question.slice(0, 120),
          answer: entry.answer.slice(0, 800),
        };
        size += short.question.length + short.answer.length + short.threadTitle.length + 120;
        if (size > 20_000) {
          truncated = true;
          break;
        }
        kept.push(short);
      }
      return { decisions: kept, omittedPicks, truncated };
    }),
  ),

  link_issue: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const now = yield* nowMs;
      const issue = yield* parseIssue(input);
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const thread =
        input.thread === undefined ? yield* callerThread : yield* resolveRef(input.thread, world);
      const holders = (yield* store
        .issueLinksFor(issue.provider, issue.identifier)
        .pipe(Effect.mapError(ledgerUnavailable)))
        .map((link) => world.byId.get(link.threadId))
        .filter(
          (holder): holder is Shell =>
            holder !== undefined && holder.id !== thread.id && !isRetired(holder),
        );
      const owner = holders[0];
      if (owner !== undefined && input.force !== true) {
        return yield* invalid(
          `${issue.identifier} is owned by "${owner.title}" (${shortId(owner.id)}) - message that thread, or pass force to take it over`,
        );
      }
      const linkedAt = DateTime.formatIso(DateTime.makeUnsafe(now));
      const linked = yield* store
        .linkIssue({
          threadId: thread.id,
          provider: issue.provider,
          identifier: issue.identifier,
          url: issue.url,
          title: input.title ?? null,
          linkedAt,
        })
        .pipe(Effect.mapError(ledgerUnavailable));
      return {
        linked,
        alreadyLinked: !linked,
        issue: {
          provider: issue.provider,
          identifier: issue.identifier,
          url: issue.url,
          title: input.title ?? null,
          linkedAt,
        },
        previousOwner: owner === undefined ? null : summaryOf(owner, now),
      };
    }),
  ),

  set_thread_role: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const thread =
        input.thread === undefined ? yield* callerThread : yield* resolveRef(input.thread, world);
      if (ledger.isReleaseManager(world, thread)) {
        return yield* invalid(
          `"${thread.title}" is this project's release manager; that is its role`,
        );
      }
      yield* store.setThreadRole(thread.id, input.role).pipe(Effect.mapError(ledgerUnavailable));
      return { threadId: thread.id, role: input.role };
    }),
  ),

  unlink_issue: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const issue = yield* parseIssue(input);
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const thread =
        input.thread === undefined ? yield* callerThread : yield* resolveRef(input.thread, world);
      const wasLinked = yield* store
        .unlinkIssue({
          threadId: thread.id,
          provider: issue.provider,
          identifier: issue.identifier,
        })
        .pipe(Effect.mapError(ledgerUnavailable));
      return { wasLinked, identifier: issue.identifier };
    }),
  ),

  list_thread_issues: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const thread =
        input.thread === undefined ? yield* callerThread : yield* resolveRef(input.thread, world);
      const links = yield* store.issueLinks(thread.id).pipe(Effect.mapError(ledgerUnavailable));
      return {
        owner: !isRetired(thread),
        issues: links.map((link) => ({
          provider: link.provider,
          identifier: link.identifier,
          url: link.url,
          title: link.title,
          linkedAt: link.linkedAt,
        })),
      };
    }),
  ),

  watch_workflow_run: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const me = yield* callerThread;
      const runWatch = yield* T4RunWatch.T4RunWatch;
      const project =
        me.worktreePath === null
          ? yield* Project.ProjectService.pipe(
              Effect.flatMap((projects) => projects.getById(me.projectId)),
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      const where = {
        threadId: me.id,
        repository: input.repository?.trim() || null,
        cwd: me.worktreePath ?? project?.workspaceRoot ?? null,
        note: input.note?.trim() || null,
      };
      const commit = input.commit?.trim();
      if (commit !== undefined && commit.length > 0) {
        if (!/^[0-9a-f]{7,40}$/i.test(commit))
          return yield* invalid(`'${commit}' is not a commit SHA`);
        const runs = yield* runWatch
          .watchCommit({ ...where, commit })
          .pipe(
            Effect.mapError((error) =>
              invalid(`couldn't read runs for ${commit}: ${error.message}`),
            ),
          );
        return {
          watching: true,
          runId: `commit ${commit.slice(0, 10)}`,
          name: `every run for commit ${commit.slice(0, 10)}`,
          status: runs.some((run) => run.status === "in_progress" || run.status === "queued")
            ? "in_progress"
            : "watching",
          conclusion: "",
          url: "",
          failedJobs: [],
          runs: [...runs],
          next: "End your turn now. You are woken as each run for this commit finishes, including runs that start later (checked every 30 s); handoffs reach you meanwhile.",
        };
      }
      const runId = String(input.runId ?? "").trim();
      if (!/^\d+$/.test(runId))
        return yield* invalid("pass `commit` (a SHA) or `runId` (a run's number)");
      const { run, watching } = yield* runWatch
        .watch({ ...where, runId })
        .pipe(Effect.mapError((error) => invalid(`couldn't read run ${runId}: ${error.message}`)));
      return {
        watching,
        runId,
        name: run.name,
        status: run.status,
        conclusion: run.conclusion,
        url: run.url,
        failedJobs: [...run.failedJobs],
        next: watching
          ? "End your turn now. A message arrives here when the run finishes (checked every 30 s); handoffs reach you meanwhile."
          : "The run already finished; act on its conclusion now.",
      };
    }),
  ),

  release_queue: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const delivery = yield* T4Delivery.T4Delivery;
      const now = yield* nowMs;
      const me = yield* callerThread;
      const world = yield* ledger.world().pipe(Effect.mapError(ledgerUnavailable));
      const notes: Array<string> = [];
      const notified: Array<string> = [];
      const updates = input.prs ?? [];
      if (updates.length > 0) {
        if (!ledger.isReleaseManager(world, me)) {
          return yield* invalid(
            "only this project's release manager records releases - hand your PR over with `t3_handoff` (no `to`)",
          );
        }
        const before = new Map(
          (yield* store
            .releaseQueue({ projectId: me.projectId, shippedSince: "0000" })
            .pipe(Effect.mapError(ledgerUnavailable))).map((row) => [row.pr, row]),
        );
        const changed: Array<T4Store.T4ReleaseRow> = [];
        for (const update of updates) {
          if (!Number.isInteger(update.pr) || update.pr <= 0) {
            return yield* invalid(`'${update.pr}' is not a PR number`);
          }
          if (update.state === "failed" && !update.note?.trim()) {
            return yield* invalid(
              `PR #${update.pr}: a failed release needs \`note\` - the failing job and a one-line cause`,
            );
          }
          const owner =
            update.owner === undefined ? undefined : yield* resolveRef(update.owner, world);
          const row = yield* store
            .updateRelease({
              projectId: me.projectId,
              pr: update.pr,
              state: update.state,
              ownerThreadId: owner?.id,
              ownerTitle: owner?.title,
              title: update.title ?? owner?.title,
              issue:
                update.issue ??
                (owner === undefined ? undefined : (issueIdIn(owner.title) ?? undefined)),
              commitSha: update.commit?.trim() || undefined,
              note: update.note?.trim() || undefined,
            })
            .pipe(Effect.mapError(ledgerUnavailable));
          if (before.get(row.pr)?.state !== row.state) changed.push(row);
        }
        if (input.notify !== false) {
          const groups = new Map<string, Array<T4Store.T4ReleaseRow>>();
          for (const row of changed) {
            if (row.state !== "staging" && row.state !== "shipped" && row.state !== "failed")
              continue;
            if (row.ownerThreadId === null) {
              notes.push(
                `PR #${row.pr} has no owner recorded - pass \`owner\` so it hears \`${row.state}\``,
              );
              continue;
            }
            const key = `${row.ownerThreadId}\u0000${row.state}`;
            groups.set(key, [...(groups.get(key) ?? []), row]);
          }
          for (const rows of groups.values()) {
            const first = rows[0]!;
            const state = first.state as "staging" | "shipped" | "failed";
            const target = world.byId.get(first.ownerThreadId!);
            const prs = rows.map((row) => row.pr);
            if (target === undefined || isRetired(target)) {
              notes.push(
                `"${first.ownerTitle ?? first.ownerThreadId}" is archived or gone - no ${state} notice for ${prs.map((pr) => `#${pr}`).join(", ")}`,
              );
              continue;
            }
            const done = state !== "staging";
            const ask = state === "failed";
            const labels = [
              ...(done ? ["answers your handoff"] : []),
              ask ? "reply expected" : "no reply needed",
            ];
            const header = handoffHeader(me, labels);
            const footer = ask
              ? `\n\n---\nAnswer with \`t3_handoff\` (to: "${shortId(me.id)}", done: true) once it is fixed. \`t3_owed\` lists what you still owe.`
              : "";
            const body = releaseNotice(
              state,
              prs,
              rows
                .map((row) => row.note)
                .filter((note): note is string => note !== null)
                .join(" ") || null,
            );
            if (done) {
              yield* store
                .settleHandoffs({ fromThreadId: target.id, toThreadId: me.id })
                .pipe(Effect.mapError(ledgerUnavailable));
            }
            const wakesNote = state === "shipped" ? yield* pendingWakesNote(target.id, now) : "";
            const delivered = yield* delivery
              .deliver({
                target,
                text: header + body + footer + wakesNote,
                senderThreadId: me.id,
                notice: !ask,
              })
              .pipe(Effect.result);
            if (Result.isFailure(delivered)) {
              notes.push(`couldn't reach "${target.title}": ${delivered.failure.message}`);
              continue;
            }
            if (ask) {
              yield* store
                .recordHandoff({
                  kind: "handoff",
                  fromThreadId: me.id,
                  fromTitle: me.title,
                  toThreadId: target.id,
                  projectId: target.projectId,
                  summary: body.slice(0, 160),
                })
                .pipe(Effect.mapError(ledgerUnavailable));
            }
            notified.push(`${state}: "${target.title}" (${prs.map((pr) => `#${pr}`).join(", ")})`);
          }
        }
      }
      const rows = yield* store
        .releaseQueue({
          projectId: me.projectId,
          shippedSince:
            input.all === true
              ? DateTime.formatIso(DateTime.makeUnsafe(now - 7 * 86_400_000))
              : undefined,
        })
        .pipe(Effect.mapError(ledgerUnavailable));
      return {
        entries: rows.map((row) => releaseEntryOf(row, world, now)),
        notified,
        notes,
      };
    }),
  ),
});
