/**
 * t4 fork: the operator API for the t4 dashboard and scripts, under
 * `/api/t4/`. V2's HTTP API is read-only and its commands go over WebSocket
 * RPC; these routes give the dashboard plain HTTP for what it does, with the
 * environment's bearer tokens (orchestration:read for GET, :operate for POST).
 */
import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  CommandId,
  MessageId,
  ModelSelection,
  type OrchestrationV2ThreadShell,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Project from "../project/ProjectService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import { factsFor } from "./T4Facts.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4RunWatch from "./T4RunWatch.ts";
import * as T4Schedules from "./T4Schedules.ts";
import * as T4Spawn from "./T4Spawn.ts";
import { clientDefaultModelSelection } from "./T4DefaultModel.ts";
import * as T4Store from "./T4Store.ts";
import { isRetired, isSettled, shortId } from "./T4Threads.ts";

type Shell = OrchestrationV2ThreadShell;

const json = (body: unknown, status = 200) => HttpServerResponse.jsonUnsafe(body, { status });

/** The request's session, or a 401/403 response to return instead. */
const authorize = Effect.fn("t4.T4Http.authorize")(function* (
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const auth = yield* EnvironmentAuth.EnvironmentAuth;
  const session = yield* auth.authenticateHttpRequest(request).pipe(Effect.option);
  if (Option.isNone(session)) return json({ error: "unauthorized" }, 401);
  if (!session.value.scopes.includes(scope)) return json({ error: `needs ${scope}` }, 403);
  return undefined;
});

const route = <E, R>(
  method: "GET" | "POST",
  path: HttpRouter.PathInput,
  scope: typeof AuthOrchestrationReadScope | typeof AuthOrchestrationOperateScope,
  handle: (
    params: Readonly<Record<string, string | undefined>>,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(
    method,
    path,
    Effect.gen(function* () {
      const denied = yield* authorize(scope);
      if (denied !== undefined) return denied;
      const params = yield* HttpRouter.params;
      return yield* handle(params);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("t4 api request failed", { path, cause }).pipe(
          Effect.as(json({ error: "t4 api request failed" }, 500)),
        ),
      ),
    ),
  );

const LaunchBody = Schema.Struct({
  projectId: ProjectId,
  title: Schema.String,
  message: Schema.String,
  branch: Schema.optional(Schema.String),
  baseRef: Schema.optional(Schema.String),
  issues: Schema.optional(Schema.Array(Schema.String)),
  modelPreset: Schema.optional(Schema.String),
  modelSelection: Schema.optional(ModelSelection),
  force: Schema.optional(Schema.Boolean),
});
const AnswerBody = Schema.Struct({
  requestId: Schema.String,
  /** The answer to the request's only (or first) question: an option label, or free text. */
  answer: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
});
const MessageBody = Schema.Struct({
  text: Schema.String,
  interrupt: Schema.optional(Schema.Boolean),
});
const ResumeBody = Schema.Struct({
  dryRun: Schema.optional(Schema.Boolean),
  batch: Schema.optional(Schema.Number),
  gapSeconds: Schema.optional(Schema.Number),
});

const body = <S extends Schema.Top>(schema: S) =>
  HttpServerRequest.HttpServerRequest.pipe(
    Effect.flatMap((request) => request.json),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
  );

/** `limited_threads()`: open threads stopped on a usage limit, release managers first, oldest stop first. */
const limitedThreads = (world: T4Ledger.T4World, ledger: T4Ledger.T4LedgerShape) =>
  world.threads
    .filter(
      (thread) =>
        thread.archivedAt === null &&
        !isSettled(thread) &&
        thread.status === "failed" &&
        thread.lastErrorClass === "usage_limit",
    )
    .toSorted((left, right) => {
      const rm =
        Number(!ledger.isReleaseManager(world, left)) -
        Number(!ledger.isReleaseManager(world, right));
      if (rm !== 0) return rm;
      const at = (t: Shell) =>
        t.latestRunCompletedAt == null ? 0 : DateTime.toEpochMillis(t.latestRunCompletedAt);
      return at(left) - at(right);
    });

export const RESUME_NOTE =
  "(Thread tools: your last turn stopped on the provider's usage limit, and it has reset. Re-read " +
  "real state (git, PRs, `t3_owed`, Linear) and carry on from where you were. Your local stack may " +
  "have been stopped while you were idle - bring it back only if you need it.)";

export const layer = Layer.mergeAll(
  route("GET", "/api/t4/state", AuthOrchestrationReadScope, () =>
    Effect.gen(function* () {
      const ledger = yield* T4Ledger.T4Ledger;
      const store = yield* T4Store.T4Store;
      const world = yield* ledger.world();
      const facts = yield* factsFor(world.threads.map((thread) => thread.id));
      // Wakes: scheduled tasks posted into a thread (V2 lists them only over WebSocket).
      const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
      const tasks =
        scheduledTasks._tag === "Some"
          ? (yield* scheduledTasks.value.list().pipe(Effect.orElseSucceed(() => ({ tasks: [] }))))
              .tasks
          : [];
      return json({
        wakes: tasks
          .filter((task) => task.threadId !== null && task.enabled && task.nextRunAt !== null)
          .map((task) => ({
            id: task.id,
            threadId: task.threadId,
            title: task.title,
            prompt: task.prompt,
            schedule: task.schedule,
            nextRunAt: task.nextRunAt,
          })),
        handoffs: world.open,
        releaseManagers: Object.fromEntries([...(yield* store.releaseManagers()).entries()]),
        issueLinks: yield* store.issueLinks(),
        settleRequests: Object.fromEntries([...(yield* store.settleRequests()).entries()]),
        threads: Object.fromEntries(facts.entries()),
        // Runs a thread waits on (watch_workflow_run): it is working, not idle.
        runWatches: yield* Effect.serviceOption(T4RunWatch.T4RunWatch).pipe(
          Effect.flatMap((service) =>
            service._tag === "Some" ? service.value.watches : Effect.succeed([]),
          ),
        ),
      });
    }),
  ),

  // Every pending question and approval across threads, for the dashboard's
  // approvals list and phone pushes (one call instead of a projection per thread).
  route("GET", "/api/t4/pending", AuthOrchestrationReadScope, () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const snapshot = yield* threads.getShellSnapshot({ location: "active" });
      const waiting = snapshot.threads.filter(
        (thread) =>
          thread.pendingRuntimeRequest !== null &&
          thread.deletedAt === null &&
          thread.archivedAt === null,
      );
      const pending: Array<Record<string, unknown>> = [];
      for (const thread of waiting) {
        // Only the item types read below, and tool calls of the running turn
        // alone: a release manager's whole history is 200+ MB, and the
        // dashboard polls this every few seconds.
        const records = yield* threads
          .getProjectThreadRecords(
            { projectId: thread.projectId, threadId: thread.id },
            ["runtimeRequests", "turnItems"],
            { turnItemTypes: ["user_input_request", "approval_request", "secret_request"] },
          )
          .pipe(Effect.orElseSucceed(() => null));
        if (records === null) continue;
        const toolItems =
          thread.activeRunId === null
            ? []
            : yield* threads
                .getProjectThreadRecords(
                  { projectId: thread.projectId, threadId: thread.id },
                  ["turnItems"],
                  { turnItemTypes: ["dynamic_tool"], turnItemRunId: thread.activeRunId },
                )
                .pipe(
                  Effect.map((tools) => tools.turnItems),
                  Effect.orElseSucceed(() => []),
                );
        // A request whose own tool call already ended was abandoned (a steered
        // message aborted the call, and the agent asks again): answering it
        // reaches no one. Builds before the adapter's cancelAbortedRequest left
        // these pending until the turn ended, next to the question asked again.
        const ended = new Set(
          toolItems
            .filter(
              (item) =>
                item.type === "dynamic_tool" &&
                item.nativeItemRef !== null &&
                (item.status === "failed" ||
                  item.status === "completed" ||
                  item.status === "cancelled"),
            )
            .map((item) => item.nativeItemRef?.nativeId),
        );
        const live = records.runtimeRequests.filter(
          (r) =>
            r.status === "pending" &&
            !(r.responseCapability.type === "live" && ended.has(r.nativeRequestRef?.nativeId)),
        );
        // t4 fork: a pending secret request (`request_secret`) waits on the user too;
        // it is entered privately in T3's card, never typed into chat.
        for (const item of records.turnItems) {
          if (item.type !== "secret_request" || item.secretStatus !== "pending") continue;
          pending.push({
            threadId: thread.id,
            threadTitle: thread.title,
            projectId: thread.projectId,
            requestId: item.id,
            createdAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
            kind: "secret",
            title: `Enter a secret: ${item.label}`,
            detail: item.reason || null,
            options: [],
          });
        }
        for (const request of live) {
          const item = records.turnItems.find(
            (candidate) =>
              (candidate.type === "user_input_request" || candidate.type === "approval_request") &&
              candidate.requestId === request.id,
          );
          const base = {
            threadId: thread.id,
            threadTitle: thread.title,
            projectId: thread.projectId,
            requestId: request.id,
            createdAt: DateTime.formatIso(request.createdAt),
          };
          if (request.kind === "user_input" || item?.type === "user_input_request") {
            const questions = item?.type === "user_input_request" ? item.questions : [];
            const first = questions[0];
            pending.push({
              ...base,
              kind: "question",
              title: first?.question ?? first?.header ?? "Question",
              more: Math.max(0, questions.length - 1),
              options: (first?.options ?? []).map((option) => option.label),
              // t4 fork: what the dashboard needs to answer it (POST .../answer).
              questionId: first?.id ?? null,
              multiSelect: first?.multiSelect === true,
            });
          } else {
            pending.push({
              ...base,
              kind: "permission",
              title:
                item?.title ??
                (item?.type === "approval_request" ? item.requestKind : request.kind),
              detail: item?.type === "approval_request" ? (item.prompt ?? null) : null,
              options: [],
            });
          }
        }
      }
      return json({ pending });
    }),
  ),

  // V2's HTTP shell lists active threads only; the dashboard's Archived tab needs these too.
  route("GET", "/api/t4/archived", AuthOrchestrationReadScope, () =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const snapshot = yield* threads.getShellSnapshot({ location: "archive" });
      const archived = [...snapshot.archivedThreads, ...snapshot.threads]
        .filter((thread) => thread.archivedAt !== null && thread.deletedAt === null)
        .toSorted(
          (left, right) =>
            DateTime.toEpochMillis(right.archivedAt ?? right.updatedAt) -
            DateTime.toEpochMillis(left.archivedAt ?? left.updatedAt),
        )
        .slice(0, 500);
      return json({ threads: archived });
    }),
  ),

  route("POST", "/api/t4/launch", AuthOrchestrationOperateScope, () =>
    Effect.gen(function* () {
      const input = yield* body(LaunchBody);
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      const config = yield* T4Config.T4ServerConfig;
      const crypto = yield* Crypto.Crypto;
      const issues = input.issues ?? [];
      const before = yield* T4Spawn.beforeLaunch({
        caller: undefined,
        projectId: input.projectId,
        issues,
        anyway: input.force === true,
        message: input.message,
      });
      if ("refused" in before) return json({ error: before.refused }, 409);
      const modelSelection =
        (input.modelPreset === undefined ? undefined : config.launchPresets[input.modelPreset]) ??
        input.modelSelection ??
        (yield* clientDefaultModelSelection(input.projectId));
      if (modelSelection === undefined)
        return json(
          { error: "pass modelPreset or modelSelection (the client has no default model)" },
          400,
        );
      const id = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      // V2 creates the worktree after accepting the launch, so a branch that
      // already exists would fail later; take a fresh one beside it now.
      let branch = input.branch;
      if (branch !== undefined) {
        const projects = yield* Project.ProjectService;
        const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
        if (project === undefined) return json({ error: "project not found" }, 404);
        const processes = yield* ProcessRunner.ProcessRunner;
        const exists = yield* processes
          .run({
            command: "git",
            args: [
              "-C",
              project.workspaceRoot,
              "show-ref",
              "--verify",
              "--quiet",
              `refs/heads/${branch}`,
            ],
            timeout: "15 seconds",
          })
          .pipe(
            Effect.map((out) => out.code === 0),
            Effect.orElseSucceed(() => false),
          );
        if (exists) branch = `${branch}-${id.slice(0, 4)}`;
      }
      const result = yield* launches.launch({
        commandId: CommandId.make(`t4:launch:${id}`),
        threadId: ThreadId.make(`t4-${id}`),
        projectId: input.projectId,
        title: input.title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        workspaceStrategy:
          input.branch === undefined
            ? { type: "root" }
            : {
                type: "worktree",
                baseRef: input.baseRef ?? "main",
                branch: input.branch,
                startFromOrigin: true,
              },
        initialMessage: {
          messageId: MessageId.make(`t4:launch:${id}`),
          text: input.message,
          attachments: [],
        },
        createdBy: "user",
        creationSource: "web",
      });
      const thread = result.projection.thread;
      yield* T4Spawn.afterLaunch({
        caller: undefined,
        threadId: thread.id,
        projectId: thread.projectId,
        issues,
        message: input.message,
      });
      return json({
        threadId: thread.id,
        title: thread.title,
        worktreePath: thread.worktreePath,
        branch: thread.branch,
      });
    }),
  ),

  route("POST", "/api/t4/threads/:threadId/restore", AuthOrchestrationOperateScope, (params) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const crypto = yield* Crypto.Crypto;
      const threadId = ThreadId.make(params.threadId ?? "");
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null) return json({ error: "thread not found" }, 404);
      const done: Array<string> = [];
      const command = (type: string) =>
        crypto.randomUUIDv4().pipe(
          Effect.orDie,
          Effect.map((uuid) => CommandId.make(`t4:restore:${type}:${uuid}`)),
        );
      if (thread.archivedAt !== null) {
        yield* threads.dispatch({
          type: "thread.unarchive",
          commandId: yield* command("unarchive"),
          threadId,
        });
        done.push("unarchived");
      }
      if (isSettled(thread)) {
        yield* threads.dispatch({
          type: "thread.unsettle",
          commandId: yield* command("unsettle"),
          threadId,
          reason: "user",
        });
        done.push("unsettled");
      }
      const now = yield* Clock.currentTimeMillis;
      if (thread.snoozedUntil != null && DateTime.toEpochMillis(thread.snoozedUntil) > now) {
        yield* threads.dispatch({
          type: "thread.unsnooze",
          commandId: yield* command("unsnooze"),
          threadId,
          reason: "user",
        });
        done.push("unsnoozed");
      }
      return json({ threadId, restored: done });
    }),
  ),

  // `t4 run`'s throwaway threads.
  route("POST", "/api/t4/threads/:threadId/delete", AuthOrchestrationOperateScope, (params) =>
    Effect.gen(function* () {
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const crypto = yield* Crypto.Crypto;
      const threadId = ThreadId.make(params.threadId ?? "");
      if ((yield* threads.getThreadShell(threadId)) === null)
        return json({ error: "thread not found" }, 404);
      const uuid = yield* crypto.randomUUIDv4().pipe(Effect.orDie);
      yield* threads.dispatch({
        type: "thread.delete",
        commandId: CommandId.make(`t4:delete:${uuid}`),
        threadId,
      });
      return json({ threadId, deleted: true });
    }),
  ),

  route("POST", "/api/t4/threads/:threadId/message", AuthOrchestrationOperateScope, (params) =>
    Effect.gen(function* () {
      const input = yield* body(MessageBody);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const delivery = yield* T4Delivery.T4Delivery;
      const thread = yield* threads.getThreadShell(ThreadId.make(params.threadId ?? ""));
      if (thread === null) return json({ error: "thread not found" }, 404);
      const result = yield* delivery.deliver({
        target: thread,
        text: input.text,
        interrupt: input.interrupt === true,
        createdBy: "user",
        creationSource: "web",
      });
      return json({ threadId: thread.id, messageId: result.messageId, delivery: result.delivery });
    }),
  ),

  // Scheduled sessions (t4/T4Schedules.ts): a prompt that starts a fresh thread
  // on a cron schedule, managed from the dashboard's client settings.
  route("GET", "/api/t4/schedules", AuthOrchestrationReadScope, () =>
    T4Schedules.listSchedules().pipe(Effect.map((schedules) => json({ schedules }))),
  ),
  route("POST", "/api/t4/schedules", AuthOrchestrationOperateScope, () =>
    Effect.gen(function* () {
      const input = yield* body(T4Schedules.SaveScheduleBody);
      if (input.title.trim().length === 0 || input.prompt.trim().length === 0) {
        return json({ error: "a schedule needs a title and a prompt" }, 400);
      }
      const saved = yield* T4Schedules.saveSchedule(input).pipe(
        Effect.catch((error) =>
          Effect.succeed({ error: String((error as { message?: unknown }).message ?? error) }),
        ),
      );
      return "error" in saved ? json({ error: saved.error }, 400) : json({ task: saved.task });
    }),
  ),
  route("POST", "/api/t4/schedules/:id/delete", AuthOrchestrationOperateScope, (params) =>
    T4Schedules.deleteSchedule(params.id ?? "").pipe(Effect.map(() => json({ deleted: true }))),
  ),
  route("POST", "/api/t4/schedules/:id/run", AuthOrchestrationOperateScope, (params) =>
    Effect.gen(function* () {
      const scheduled = yield* ScheduledTasks.ScheduledTaskService;
      const result = yield* scheduled.runNow({ id: ScheduledTaskId.make(params.id ?? "") });
      return json({ threadId: result.threadId });
    }),
  ),

  // The dashboard answers a one-question card the way T3's own card does.
  route("POST", "/api/t4/threads/:threadId/answer", AuthOrchestrationOperateScope, (params) =>
    Effect.gen(function* () {
      const input = yield* body(AnswerBody);
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const threadId = ThreadId.make(params.threadId ?? "");
      const thread = yield* threads.getThreadShell(threadId);
      if (thread === null) return json({ error: "thread not found" }, 404);
      const records = yield* threads.getProjectThreadRecords(
        { projectId: thread.projectId, threadId },
        ["turnItems", "runtimeRequests"],
        { turnItemTypes: ["user_input_request"] },
      );
      const request = records.runtimeRequests.find(
        (candidate) => candidate.id === input.requestId && candidate.status === "pending",
      );
      if (request === undefined) return json({ error: "that question is no longer open" }, 409);
      const item = records.turnItems.find(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      const questions = item?.type === "user_input_request" ? item.questions : [];
      if (questions.length !== 1) {
        return json({ error: "answer this one in T3: it asks more than one question" }, 400);
      }
      const raw = input.answer;
      const answer =
        typeof raw === "string"
          ? raw.trim()
          : raw.map((pick) => pick.trim()).filter((pick) => pick.length > 0);
      if (answer.length === 0) return json({ error: "empty answer" }, 400);
      const crypto = yield* Crypto.Crypto;
      yield* threads.dispatch({
        type: "runtime-request.respond",
        commandId: CommandId.make(`t4:dashboard-answer:${yield* crypto.randomUUIDv4()}`),
        threadId,
        requestId: request.id,
        answers: { [questions[0]!.id]: answer },
      });
      return json({ ok: true });
    }),
  ),

  route("POST", "/api/t4/resume-limited", AuthOrchestrationOperateScope, () =>
    Effect.gen(function* () {
      const input = yield* body(ResumeBody).pipe(
        Effect.orElseSucceed(() => ({}) as typeof ResumeBody.Type),
      );
      const ledger = yield* T4Ledger.T4Ledger;
      const threads = yield* ThreadManagementService.ThreadManagementService;
      const delivery = yield* T4Delivery.T4Delivery;
      const world = yield* ledger.world();
      const todo = limitedThreads(world, ledger);
      const listed = todo.map((thread) => ({
        threadId: thread.id,
        shortId: shortId(thread.id),
        title: thread.title,
      }));
      if (todo.length === 0 || input.dryRun === true)
        return json({ started: false, threads: listed });
      const batch = Math.max(1, input.batch ?? 3);
      const gap = Duration.seconds(Math.max(1, input.gapSeconds ?? 60));
      const resume = (thread: Shell) =>
        delivery.deliver({
          target: thread,
          text: RESUME_NOTE,
          force: true,
          createdBy: "system",
          creationSource: "server",
        });
      const stillLimited = (threadId: Shell["id"]) =>
        threads.getThreadShell(threadId).pipe(
          Effect.map(
            (t) => t !== null && t.status === "failed" && t.lastErrorClass === "usage_limit",
          ),
          Effect.orElseSucceed(() => true),
        );
      // `cmd_resume`: probe one; if its turn is refused again within 20 s the
      // limit has not reset - stop. Otherwise the rest, a few at a time.
      const run = Effect.gen(function* () {
        const [probe, ...rest] = todo;
        if (probe === undefined) return;
        yield* resume(probe);
        yield* Effect.sleep(Duration.seconds(20));
        if (yield* stillLimited(probe.id)) {
          yield* Effect.logInfo("t4 resume: the limit has not reset yet", { probe: probe.id });
          return;
        }
        for (let i = 0; i < rest.length; i += batch) {
          if (i > 0) yield* Effect.sleep(gap);
          for (const thread of rest.slice(i, i + batch)) {
            const fresh = yield* threads
              .getThreadShell(thread.id)
              .pipe(Effect.orElseSucceed(() => null));
            if (fresh === null || fresh.status !== "failed") continue; // already moving
            yield* resume(fresh).pipe(Effect.ignore);
          }
        }
      }).pipe(Effect.ignoreCause({ log: true }));
      yield* Effect.forkDetach(run);
      return json({ started: true, threads: listed });
    }),
  ),
);

/** Threads whose standing the dashboard reads (exported for tests). */
export const _internal = { limitedThreads, isRetired };
