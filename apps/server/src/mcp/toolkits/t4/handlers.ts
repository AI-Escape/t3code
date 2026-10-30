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
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as T4Config from "../../../t4/T4Config.ts";
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
      const header = `HANDOFF from "${me.title}" (${shortId(me.id)}, ${whereOf(me)}) — ${labels.join(" · ")}:\n\n`;
      const footer = ask
        ? `\n\n---\nAnswer with \`t3_handoff\` (to: "${shortId(me.id)}", done: true; add fyi: true if you ask nothing back). \`t3_owed\` lists what you still owe.`
        : "";
      const summary = (body.split("\n")[0] ?? "").slice(0, 160);

      if (target === undefined) {
        // No release manager yet: start one with this handoff as its first turn.
        const crypto = yield* Crypto.Crypto;
        const launches = yield* ThreadLaunch.ThreadLaunchService;
        const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
        const title = `${config.releaseManagerTitlePrefix} — ${project.title}`;
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
      const delivered = yield* delivery
        .deliver({
          target,
          text: header + body + footer,
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
      const { caller, threads } = yield* readCaller();
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
      for (const thread of scope) {
        const records = yield* threads
          .getProjectThreadRecords({ projectId: thread.projectId, threadId: thread.id }, [
            "runtimeRequests",
            "turnItems",
          ])
          .pipe(Effect.orElseSucceed(() => null));
        if (records === null) continue;
        for (const request of records.runtimeRequests) {
          if (request.kind !== "user_input" || request.status !== "resolved") continue;
          if (request.resolvedAt === null || DateTime.toEpochMillis(request.resolvedAt) < cutoffMs)
            continue;
          const item = records.turnItems.find(
            (candidate) =>
              candidate.type === "user_input_request" && candidate.requestId === request.id,
          );
          const questions = item?.type === "user_input_request" ? item.questions : [];
          for (const [questionId, raw] of Object.entries(request.answers ?? {})) {
            const question = questions.find((q) => q.id === questionId);
            const answer = Array.isArray(raw) ? raw.map(String).join(", ") : String(raw);
            const labels = new Set((question?.options ?? []).map((option) => option.label));
            const picked = answer.split(",").map((part) => part.trim());
            decisions.push({
              answeredAt: DateTime.formatIso(request.resolvedAt),
              threadId: thread.id,
              threadTitle: thread.title,
              question: (question?.question ?? question?.header ?? questionId)
                .replaceAll(/\s+/g, " ")
                .slice(0, 160),
              answer: answer.replaceAll(/\s+/g, " "),
              isNote: !(labels.has(answer) || picked.every((part) => labels.has(part))),
            });
          }
        }
      }
      return {
        decisions: decisions.toSorted((left, right) =>
          right.answeredAt.localeCompare(left.answeredAt),
        ),
      };
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
      const runId = String(input.runId).trim();
      if (!/^\d+$/.test(runId)) return yield* invalid(`'${runId}' is not a workflow run id`);
      const project =
        me.worktreePath === null
          ? yield* Project.ProjectService.pipe(
              Effect.flatMap((projects) => projects.getById(me.projectId)),
              Effect.map(Option.getOrUndefined),
              Effect.orElseSucceed(() => undefined),
            )
          : undefined;
      const { run, watching } = yield* runWatch
        .watch({
          threadId: me.id,
          runId,
          repository: input.repository?.trim() || null,
          cwd: me.worktreePath ?? project?.workspaceRoot ?? null,
          note: input.note?.trim() || null,
        })
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
          ? "End your turn now. A message arrives here when the run finishes; handoffs reach you meanwhile."
          : "The run already finished; act on its conclusion now.",
      };
    }),
  ),
});
