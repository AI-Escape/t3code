import { OrchestratorMcpFailure } from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";

import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as ScheduledTasks from "../../../scheduledTasks/ScheduledTaskService.ts";
import * as Option from "effect/Option";
import * as T4Delivery from "../../../t4/T4Delivery.ts";
import * as T4Facts from "../../../t4/T4Facts.ts";
import * as Wakes from "../../../t4/wakes.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.capabilities(scope);
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  t3_workflow_stop: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads } = yield* readCaller();
        return yield* threads.stopWorkflow(input).pipe(
          Effect.as({}),
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code:
                  cause.reason === "unavailable" || cause.reason === "stop-failed"
                    ? "orchestration_error"
                    : "invalid_request",
                message: cause.message,
              }),
          ),
        );
      }),
  ),
  schedule_task: McpToolAccess.startsThreads(
    // A scheduled task runs with the caller's own modes.
    () => ({}),
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // t4 fork: a task posted into a thread is a wake - t4's limits and
        // its "WAKE (scheduled …)" header (t4/wakes.ts).
        const { caller } = yield* readCaller();
        const schedule = input.schedule as Wakes.WakeSchedule;
        const boundThreadId =
          input.threadId ??
          ((input.bindToCurrentThread ??
          (caller !== undefined && (input.projectId ?? caller.projectId) === caller.projectId))
            ? caller?.id
            : undefined);
        if (boundThreadId === undefined || schedule.type === "webhook") {
          return yield* service.scheduleTask(scope, input);
        }
        const scheduledTasks = yield* ScheduledTasks.ScheduledTaskService;
        const { tasks } = yield* scheduledTasks.list().pipe(Effect.mapError(unavailable));
        const pending = tasks.filter(
          (task) => task.threadId === boundThreadId && task.enabled && task.nextRunAt !== null,
        ).length;
        const now = yield* Clock.currentTimeMillis;
        const refused = Wakes.wakeRefusal(schedule, pending, now);
        if (refused !== undefined) {
          return yield* new OrchestratorMcpFailure({ code: "invalid_request", message: refused });
        }
        return yield* service.scheduleTask(scope, {
          ...input,
          prompt: Wakes.wakePrompt({
            note: input.prompt,
            scheduledAtLabel: `${DateTime.formatIso(DateTime.makeUnsafe(now)).slice(0, 16).replace("T", " ")} UTC`,
            byTitle: caller?.title,
            recurring: schedule.type !== "once",
          }),
        });
      }),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  update_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.updateScheduledTask(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.listThreads(scope, input);
      // t4 fork: each thread's ledger standing and linked issues.
      const facts = yield* T4Facts.optionalFactsFor(
        result.threads.map((thread) => thread.threadId),
      );
      return {
        ...result,
        threads: result.threads.map((thread) => {
          const t4 = facts.get(thread.threadId);
          return t4 === undefined ? thread : { ...thread, t4 };
        }),
      };
    }),
  ),
  // Reading a child's finished result also acknowledges its delivery to the
  // reader's own thread. That is bookkeeping on the caller's own subagent, not
  // a change to anything it reads, so this stays a read.
  t3_thread_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.readThread(scope, input);
      // t4 fork: the thread's ledger standing and linked issues.
      const t4 = (yield* T4Facts.optionalFactsFor([result.thread.threadId])).get(
        result.thread.threadId,
      );
      return t4 === undefined ? result : { ...result, thread: { ...result.thread, t4 } };
    }),
  ),
  t3_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  t3_thread_send: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        // t4 fork: a message from another thread carries t4's sender header
        // and delivery notes; archived targets are refused (T4Delivery).
        const t4 = yield* Effect.serviceOption(T4Delivery.T4Delivery);
        const { caller, threads } = yield* readCaller();
        if (Option.isSome(t4) && caller !== undefined && caller.id !== input.threadId) {
          const target = yield* threads
            .getThreadShell(input.threadId)
            .pipe(Effect.mapError(unavailable));
          if (target !== null) {
            const message = yield* t4.value
              .decorate({ sender: caller, target, text: input.message })
              .pipe(
                Effect.mapError(
                  (error) =>
                    new OrchestratorMcpFailure({
                      code: "thread_not_sendable",
                      message: error.message,
                    }),
                ),
              );
            return yield* service.sendToThread(scope, { ...input, message });
          }
        }
        return yield* service.sendToThread(scope, input);
      }),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  ),
  t3_thread_interrupt: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.interruptThread(scope, input);
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
