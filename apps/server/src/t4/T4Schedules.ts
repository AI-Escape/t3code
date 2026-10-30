/**
 * t4 fork: scheduled sessions - a prompt that starts a fresh thread on a
 * schedule (a daily Sentry triage, a weekly report), managed from the t4
 * dashboard's client settings.
 *
 * They are T3's own scheduled tasks (not bound to a thread, so every run
 * launches a new one) with t4's cron schedule, so daily, weekly, monthly or
 * every-N-hours timings are one expression in the server's time zone. A task
 * T3 stores keeps the model it was saved with; one saved as "the client's
 * default" is listed in t4_meta and kept on the client's current default by
 * `syncDefaultModels` (a minute after the default changes, at most).
 */
import { ModelSelection, ProjectId, ScheduledTaskId, type ScheduledTask } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { clientDefaultModelSelection } from "./T4DefaultModel.ts";
import * as T4Store from "./T4Store.ts";

const DEFAULT_MODEL_KEY = "schedules-on-default-model";
const Ids = Schema.fromJsonString(Schema.Array(Schema.String));

export const SaveScheduleBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  projectId: Schema.String,
  title: Schema.String,
  prompt: Schema.String,
  enabled: Schema.Boolean,
  /** Five-field cron in the server's time zone. */
  cron: Schema.String,
  /** null or absent: the client's default model, followed when it changes. */
  modelSelection: Schema.optional(Schema.NullOr(ModelSelection)),
});
export type SaveScheduleBody = typeof SaveScheduleBody.Type;

const readDefaultIds = (store: T4Store.T4StoreShape) =>
  store.meta(DEFAULT_MODEL_KEY).pipe(
    Effect.flatMap((text) =>
      text === undefined ? Effect.succeed([]) : Schema.decodeEffect(Ids)(text),
    ),
    Effect.orElseSucceed((): ReadonlyArray<string> => []),
  );
const writeDefaultIds = (store: T4Store.T4StoreShape, ids: ReadonlyArray<string>) =>
  Schema.encodeEffect(Ids)([...new Set(ids)]).pipe(
    Effect.flatMap((text) => store.setMeta(DEFAULT_MODEL_KEY, text)),
    Effect.ignore,
  );

/** A session schedule: launches a new thread each run (not a wake, not a webhook). */
export const isSessionSchedule = (task: ScheduledTask) =>
  task.threadId === null && task.schedule.type !== "webhook";

export const listSchedules = Effect.fn("t4.T4Schedules.list")(function* () {
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const store = yield* T4Store.T4Store;
  const { tasks } = yield* scheduled.list();
  const onDefault = new Set(yield* readDefaultIds(store));
  return tasks.filter(isSessionSchedule).map((task) => ({
    id: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    schedule: task.schedule,
    cron: task.schedule.type === "cron" ? task.schedule.expression : null,
    modelSelection: task.modelSelection,
    defaultModel: onDefault.has(task.id),
    nextRunAt: task.nextRunAt,
    lastRunAt: task.lastRunAt,
    lastRunStatus: task.lastRunStatus,
    lastRunError: task.lastRunError,
    runCount: task.runCount,
  }));
});

export const saveSchedule = Effect.fn("t4.T4Schedules.save")(function* (input: SaveScheduleBody) {
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const store = yield* T4Store.T4Store;
  const projectId = ProjectId.make(input.projectId);
  const onDefault = input.modelSelection == null;
  const modelSelection = onDefault
    ? yield* clientDefaultModelSelection(projectId)
    : input.modelSelection;
  if (modelSelection === undefined || modelSelection === null) {
    return { error: "this client has no default model set - choose a model" } as const;
  }
  const result = yield* scheduled.upsert({
    ...(input.id === undefined
      ? {}
      : { id: ScheduledTaskId.make(input.id), requireExisting: true }),
    title: input.title.trim(),
    prompt: input.prompt.trim(),
    enabled: input.enabled,
    schedule: { type: "cron", expression: input.cron.trim() },
    projectId,
    threadId: null,
    // The project's main checkout: a session that needs to change code
    // launches its own worktree thread (as the triage skill does).
    workspaceStrategy: { type: "root" },
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdBy: "user",
    creationSource: "web",
  });
  const ids = yield* readDefaultIds(store);
  yield* writeDefaultIds(
    store,
    onDefault ? [...ids, result.task.id] : ids.filter((id) => id !== result.task.id),
  );
  return { task: result.task } as const;
});

export const deleteSchedule = Effect.fn("t4.T4Schedules.delete")(function* (id: string) {
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const store = yield* T4Store.T4Store;
  yield* scheduled.delete({ id: ScheduledTaskId.make(id) });
  yield* writeDefaultIds(
    store,
    (yield* readDefaultIds(store)).filter((other) => other !== id),
  );
});

const sameModel = (left: ModelSelection, right: ModelSelection) =>
  left.instanceId === right.instanceId &&
  left.model === right.model &&
  JSON.stringify(left.options ?? []) === JSON.stringify(right.options ?? []);

/** Keeps every "client default" schedule on the client's current default model. */
export const syncDefaultModels = Effect.gen(function* () {
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const store = yield* T4Store.T4Store;
  const ids = new Set(yield* readDefaultIds(store));
  if (ids.size === 0) return;
  const { tasks } = yield* scheduled.list();
  for (const task of tasks) {
    if (!ids.has(task.id)) continue;
    const current = yield* clientDefaultModelSelection(task.projectId);
    if (current === undefined || sameModel(current, task.modelSelection)) continue;
    yield* scheduled.upsert({
      id: task.id,
      requireExisting: true,
      title: task.title,
      prompt: task.prompt,
      enabled: task.enabled,
      schedule: task.schedule as never,
      projectId: task.projectId,
      threadId: task.threadId,
      workspaceStrategy: task.workspaceStrategy,
      modelSelection: current,
      runtimeMode: task.runtimeMode,
      interactionMode: task.interactionMode,
    });
    yield* Effect.logInfo("t4: schedule follows the client's default model", {
      taskId: task.id,
      model: current.model,
    });
  }
}).pipe(Effect.ignoreCause({ log: true }));
