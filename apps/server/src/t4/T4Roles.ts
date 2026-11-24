// @effect-diagnostics processEnvInEffect:off -- trigger commands run with the container's env.
/**
 * t4 fork (AI-140): standing roles - pinned threads that never settle, woken by check-ins
 * (scheduled tasks bound to the thread) and by triggers: commands printing new items as
 * `{"items":[{id,title,url?,detail?}],"state"?}`, deduped, batched and delivered as one message.
 */
import {
  CommandId,
  MessageId,
  ModelSelection,
  ProjectId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Project from "../project/ProjectService.ts";
import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import { clientDefaultModelSelection } from "./T4DefaultModel.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Delivery from "./T4Delivery.ts";
import * as T4Store from "./T4Store.ts";
import { isRunning, stateOf } from "./T4Threads.ts";
import { setThreadCompaction } from "./threadCompaction.ts";

const CheckIn = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  /** Five-field cron in the server's time zone. */
  cron: Schema.String,
  prompt: Schema.String,
});

const Trigger = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  command: Schema.String,
  everyMinutes: Schema.Number,
  batchMinutes: Schema.Number,
  enabled: Schema.Boolean,
});

const QuietHours = Schema.Struct({ start: Schema.String, end: Schema.String });

export const RoleConfig = Schema.Struct({
  brief: Schema.String,
  model: Schema.NullOr(ModelSelection),
  compactAtTokens: Schema.NullOr(Schema.Number),
  checkIns: Schema.Array(CheckIn),
  triggers: Schema.Array(Trigger),
  quietHours: Schema.NullOr(QuietHours),
  maxTriggerTurnsPerDay: Schema.Number,
});
export type RoleConfig = typeof RoleConfig.Type;

export const SaveRoleBody = Schema.Struct({
  id: Schema.optional(Schema.String),
  kind: Schema.String,
  title: Schema.String,
  projectId: Schema.String,
  enabled: Schema.Boolean,
  config: RoleConfig,
});
export type SaveRoleBody = typeof SaveRoleBody.Type;

export const RunRoleBody = Schema.Struct({ triggerId: Schema.optional(Schema.String) });
export const RmCompactionBody = Schema.Struct({ compactAtTokens: Schema.NullOr(Schema.Number) });

const ConfigJson = Schema.fromJsonString(RoleConfig);
const decodeConfig = Schema.decodeEffect(ConfigJson);
const encodeConfig = Schema.encodeEffect(ConfigJson);

const Item = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  url: Schema.optional(Schema.NullOr(Schema.String)),
  detail: Schema.optional(Schema.NullOr(Schema.String)),
});
type Item = typeof Item.Type;
const ProbeOutput = Schema.Struct({
  items: Schema.Array(Item),
  state: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeProbe = Schema.decodeUnknownEffect(Schema.fromJsonString(ProbeOutput));

const TriggerState = Schema.Struct({
  state: Schema.String,
  since: Schema.NullOr(Schema.String),
  lastRunAt: Schema.NullOr(Schema.String),
  lastOk: Schema.NullOr(Schema.Boolean),
  lastError: Schema.NullOr(Schema.String),
  failures: Schema.Number,
  lastFailNoteAt: Schema.NullOr(Schema.String),
  lastFiredAt: Schema.NullOr(Schema.String),
  seen: Schema.Array(Schema.String),
  pending: Schema.Array(Item),
  pendingSince: Schema.NullOr(Schema.String),
});
type TriggerState = typeof TriggerState.Type;
const TriggerStateJson = Schema.fromJsonString(TriggerState);
const decodeTriggerState = Schema.decodeEffect(TriggerStateJson);
const encodeTriggerState = Schema.encodeEffect(TriggerStateJson);

const CheckInIds = Schema.fromJsonString(Schema.Record(Schema.String, Schema.String));
const decodeCheckInIds = Schema.decodeEffect(CheckInIds);
const encodeCheckInIds = Schema.encodeEffect(CheckInIds);

const SEEN_MAX = 1000;
const PENDING_MAX = 200;
const ITEMS_PER_MESSAGE = 30;
const FAIL_NOTE_AFTER = 3;
const FAIL_NOTE_EVERY_MS = 6 * 3600_000;
const PROBE_TIMEOUT = "60 seconds";
const RM_COMPACT_KEY = "rm-compact-at";
/** A project's release manager is a standing role of this kind (made by `ensureReleaseManagerRoles`). */
const RELEASE_MANAGER_KIND = "release-manager";
const rmRoleId = (projectId: string) => `role-rm-${projectId}`;
const RM_DEPLOY_TRIGGER = {
  id: "deploy-failed",
  label: "Production deploy failed",
  command: "t4-probe gh-main-red --name-match deploy",
  everyMinutes: 5,
  batchMinutes: 0,
  enabled: true,
} as const;
const triggerKey = (roleId: string, triggerId: string) => `role-trigger:${roleId}:${triggerId}`;
const checkInsKey = (roleId: string) => `role-checkins:${roleId}`;
const turnsKey = (roleId: string) => `role-turns:${roleId}`;

const emptyTriggerState = (): TriggerState => ({
  state: "",
  since: null,
  lastRunAt: null,
  lastOk: null,
  lastError: null,
  failures: 0,
  lastFailNoteAt: null,
  lastFiredAt: null,
  seen: [],
  pending: [],
  pendingSince: null,
});

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const msOf = (text: string | null) => (text === null ? 0 : Date.parse(text));

const pacificParts = (ms: number) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Los_Angeles",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(ms);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return {
    day: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
};

const minutesOf = (hhmm: string) => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return match === null ? null : Number(match[1]) * 60 + Number(match[2]);
};

/** Inside quiet hours (Pacific); a window may wrap midnight. */
export const inQuietHours = (quiet: RoleConfig["quietHours"], nowMs: number): boolean => {
  if (quiet === null) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === null || end === null || start === end) return false;
  const now = pacificParts(nowMs).minutes;
  return start < end ? now >= start && now < end : now >= start || now < end;
};

/** Merges a run's items into a trigger's state: new ones (not seen) become pending. */
export const mergeItems = (
  previous: TriggerState,
  items: ReadonlyArray<Item>,
  nowMs: number,
): { readonly next: TriggerState; readonly added: number } => {
  const seen = new Set(previous.seen);
  const baseline = previous.lastOk === null && previous.since === null;
  const fresh = items.filter((item) => !seen.has(item.id));
  const seenNext = [...previous.seen, ...fresh.map((item) => item.id)].slice(-SEEN_MAX);
  if (baseline || fresh.length === 0) {
    return { next: { ...previous, seen: seenNext }, added: 0 };
  }
  const pending = [...previous.pending, ...fresh].slice(-PENDING_MAX);
  return {
    next: {
      ...previous,
      seen: seenNext,
      pending,
      pendingSince: previous.pendingSince ?? iso(nowMs),
    },
    added: fresh.length,
  };
};

const roleFooter = (role: { readonly id: string; readonly title: string }) =>
  `(Standing role "${role.title}" - notebook \`~/.config/t4/roles/${role.id}.md\`.)`;

export const triggerMessage = (
  batches: ReadonlyArray<{ readonly label: string; readonly items: ReadonlyArray<Item> }>,
  role: { readonly id: string; readonly title: string },
): string => {
  const sections = batches.map(({ label, items }) => {
    const lines = items.slice(0, ITEMS_PER_MESSAGE).map((item) => {
      const title = item.url ? `[${item.title}](${item.url})` : item.title;
      return `- ${title}${item.detail ? ` - ${item.detail}` : ""}`;
    });
    const more =
      items.length > ITEMS_PER_MESSAGE ? [`- and ${items.length - ITEMS_PER_MESSAGE} more`] : [];
    return [`t4 role trigger - **${label}**: ${items.length} new`, ...lines, ...more].join("\n");
  });
  return `${sections.join("\n\n")}\n\nHandle them as your role skill says. If none needs anything, end your turn in one line.\n${roleFooter(role)}`;
};

const roleIntro = (role: T4Store.T4RoleRow, config: RoleConfig) => {
  const checkIns = config.checkIns.map((c) => `- ${c.label}: \`${c.cron}\``).join("\n") || "- none";
  const triggers =
    config.triggers
      .map((t) => `- ${t.label}: \`${t.command}\` every ${t.everyMinutes} min`)
      .join("\n") || "- none";
  return [
    `You are the standing role **${role.title}** (role id \`${role.id}\`, kind \`${role.kind}\`) for this client: a persistent thread that never settles.`,
    `Load the \`standing-role\` skill and the \`role-${role.kind}\` skill if there is one, and follow them. You run in the project's main checkout. Your notebook is \`~/.config/t4/roles/${role.id}.md\`.`,
    "",
    "Check-ins (scheduled messages into this thread):",
    checkIns,
    "",
    "Triggers (t4 runs these and messages you only when something is new):",
    triggers,
    "",
    "Your brief from the user:",
    "",
    config.brief.trim() || "(none)",
    "",
    "Start by reading your notebook (create it if missing) and the skill, then end your turn in one line: your first check-in or trigger will wake you.",
  ].join("\n");
};

const readTriggerState = (store: T4Store.T4StoreShape, roleId: string, triggerId: string) =>
  store.meta(triggerKey(roleId, triggerId)).pipe(
    Effect.flatMap((text) =>
      text === undefined ? Effect.succeed(emptyTriggerState()) : decodeTriggerState(text),
    ),
    Effect.orElseSucceed(emptyTriggerState),
  );
const writeTriggerState = (
  store: T4Store.T4StoreShape,
  roleId: string,
  triggerId: string,
  state: TriggerState,
) =>
  encodeTriggerState(state).pipe(
    Effect.flatMap((text) => store.setMeta(triggerKey(roleId, triggerId), text)),
    Effect.ignore,
  );

const readCheckInIds = (store: T4Store.T4StoreShape, roleId: string) =>
  store.meta(checkInsKey(roleId)).pipe(
    Effect.flatMap((text): Effect.Effect<Record<string, string>, unknown> =>
      text === undefined ? Effect.succeed({}) : decodeCheckInIds(text),
    ),
    Effect.orElseSucceed((): Record<string, string> => ({})),
  );

const turnsToday = (store: T4Store.T4StoreShape, roleId: string, nowMs: number) =>
  store.meta(turnsKey(roleId)).pipe(
    Effect.map((text) => {
      const [day, count] = (text ?? "").split(" ");
      return day === pacificParts(nowMs).day ? Number(count) || 0 : 0;
    }),
    Effect.orElseSucceed(() => 0),
  );

const configOf = (row: T4Store.T4RoleRow) =>
  decodeConfig(row.configJson).pipe(Effect.orElseSucceed((): RoleConfig | undefined => undefined));

const rmCompaction = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const config = yield* T4Config.T4ServerConfig;
  const text = yield* store.meta(RM_COMPACT_KEY).pipe(Effect.orElseSucceed(() => undefined));
  const override = text === undefined || text === "" ? undefined : Number(text);
  return {
    compactAtTokens:
      override !== undefined && Number.isFinite(override) && override > 0 ? override : null,
    defaultCompactAtTokens: config.releaseManagerCompactAtTokens,
  };
});

export const listRoles = Effect.fn("t4.T4Roles.list")(function* () {
  const store = yield* T4Store.T4Store;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const rows = yield* store.roles();
  const now = yield* Clock.currentTimeMillis;
  const { tasks } = yield* scheduled.list().pipe(Effect.orElseSucceed(() => ({ tasks: [] })));
  const roles = [];
  for (const row of rows) {
    const config = yield* configOf(row);
    if (config === undefined) continue;
    const shell =
      row.threadId === null
        ? null
        : yield* threads
            .getThreadShell(ThreadId.make(row.threadId))
            .pipe(Effect.orElseSucceed(() => null));
    const ids = yield* readCheckInIds(store, row.id);
    const triggerStatus = [];
    for (const trigger of config.triggers) {
      const state = yield* readTriggerState(store, row.id, trigger.id);
      triggerStatus.push({
        id: trigger.id,
        lastRunAt: state.lastRunAt,
        lastOk: state.lastOk,
        lastError: state.lastError,
        lastFiredAt: state.lastFiredAt,
        pending: state.pending.length,
        seen: state.seen.length,
      });
    }
    roles.push({
      id: row.id,
      kind: row.kind,
      title: row.title,
      projectId: row.projectId,
      threadId: row.threadId,
      enabled: row.enabled,
      config,
      status: {
        threadState: shell === null ? null : stateOf(shell, now),
        checkIns: config.checkIns.map((checkIn) => {
          const task = tasks.find((t) => t.id === ids[checkIn.id]);
          return {
            id: checkIn.id,
            nextRunAt: task?.nextRunAt == null ? null : String(task.nextRunAt),
            lastRunAt: task?.lastRunAt == null ? null : String(task.lastRunAt),
          };
        }),
        triggers: triggerStatus,
        triggerTurnsToday: yield* turnsToday(store, row.id, now),
      },
    });
  }
  return { roles, releaseManager: yield* rmCompaction };
});

const pinCommand = (type: "thread.pin" | "thread.unpin", threadId: string, uuid: string) => ({
  type,
  commandId: CommandId.make(`t4:role-${type === "thread.pin" ? "pin" : "unpin"}:${uuid}`),
  threadId: ThreadId.make(threadId),
});

/** Brings a role's check-in tasks in line with its config (and its enabled state). */
const syncCheckIns = Effect.fn("t4.T4Roles.syncCheckIns")(function* (
  row: T4Store.T4RoleRow,
  config: RoleConfig,
  modelSelection: ModelSelection,
) {
  const store = yield* T4Store.T4Store;
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const ids = yield* readCheckInIds(store, row.id);
  const next: Record<string, string> = {};
  const live = row.enabled && row.threadId !== null;
  for (const checkIn of config.checkIns) {
    if (!live || checkIn.cron.trim() === "" || checkIn.prompt.trim() === "") continue;
    const existing = ids[checkIn.id];
    const result = yield* scheduled
      .upsert({
        ...(existing === undefined ? {} : { id: ScheduledTaskId.make(existing) }),
        title: `${row.title}: ${checkIn.label || "check-in"}`,
        prompt: `Scheduled check-in - **${checkIn.label || "check-in"}** (${row.title}).\n\n${checkIn.prompt.trim()}\n\n${roleFooter(row)}`,
        enabled: true,
        schedule: { type: "cron", expression: checkIn.cron.trim() },
        projectId: ProjectId.make(row.projectId),
        threadId: ThreadId.make(row.threadId!),
        threadMode: "continue",
        workspaceStrategy: { type: "root" },
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.option);
    if (Option.isSome(result)) next[checkIn.id] = result.value.task.id;
  }
  for (const [checkInId, taskId] of Object.entries(ids)) {
    if (next[checkInId] === taskId) continue;
    yield* scheduled.delete({ id: ScheduledTaskId.make(taskId) }).pipe(Effect.ignore);
  }
  yield* encodeCheckInIds(next).pipe(
    Effect.flatMap((text) => store.setMeta(checkInsKey(row.id), text)),
    Effect.ignore,
  );
});

export const saveRole = Effect.fn("t4.T4Roles.save")(function* (input: SaveRoleBody) {
  const store = yield* T4Store.T4Store;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* Project.ProjectService;
  const crypto = yield* SecureRandom.SecureRandom;
  const now = yield* Clock.currentTimeMillis;
  const title = input.title.trim();
  if (title === "") return { error: "a role needs a title" } as const;
  const project = Option.getOrUndefined(
    yield* projects
      .getById(ProjectId.make(input.projectId))
      .pipe(Effect.orElseSucceed(() => Option.none())),
  );
  if (project === undefined) return { error: "project not found" } as const;
  for (const trigger of input.config.triggers) {
    if (!(trigger.everyMinutes >= 1))
      return { error: `trigger "${trigger.label}" must run at most once a minute` } as const;
  }
  const rows = yield* store.roles();
  const previous = input.id === undefined ? undefined : rows.find((row) => row.id === input.id);
  if (input.id !== undefined && previous === undefined) return { error: "role not found" } as const;
  const isRm = previous?.kind === RELEASE_MANAGER_KIND;
  if (!isRm && input.kind.trim() === RELEASE_MANAGER_KIND) {
    return {
      error: "a project's release manager role is made with its release manager - edit that one",
    } as const;
  }
  const serverConfig = yield* T4Config.T4ServerConfig;
  const modelSelection =
    input.config.model ??
    (isRm ? serverConfig.releaseManagerModel : null) ??
    (yield* clientDefaultModelSelection(project.id));
  if (modelSelection === undefined || modelSelection === null) {
    return { error: "this client has no default model set - choose a model" } as const;
  }
  const id = previous?.id ?? `role-${yield* crypto.uuidV4().pipe(Effect.orDie)}`;
  let threadId = previous?.threadId ?? null;
  // A role thread that was deleted is made again.
  if (threadId !== null) {
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.orElseSucceed(() => null));
    if (shell === null || shell.deletedAt !== null) threadId = null;
  }
  let row: T4Store.T4RoleRow = {
    id,
    // A release manager stays one: its thread, project and on state are the release flow's.
    kind: isRm ? RELEASE_MANAGER_KIND : input.kind.trim() || "custom",
    title,
    projectId: isRm ? previous!.projectId : project.id,
    threadId: isRm ? previous!.threadId : threadId,
    enabled: isRm ? true : input.enabled,
    configJson: yield* encodeConfig(input.config).pipe(Effect.orDie),
    createdAt: previous?.createdAt ?? iso(now),
    updatedAt: iso(now),
  };
  if (!isRm && row.enabled && threadId === null) {
    const uuid = yield* crypto.uuidV4().pipe(Effect.orDie);
    const launched = yield* launches.launch({
      commandId: CommandId.make(`t4:role:${uuid}`),
      threadId: ThreadId.make(`t4-role-${uuid}`),
      projectId: project.id,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: {
        messageId: MessageId.make(`t4:role:${uuid}`),
        text: roleIntro(row, input.config),
        attachments: [],
      },
      createdBy: "user",
      creationSource: "web",
    });
    threadId = launched.projection.thread.id;
    row = { ...row, threadId };
  }
  threadId = row.threadId;
  yield* store.upsertRole(row);
  if (threadId !== null) {
    const uuid = yield* crypto.uuidV4().pipe(Effect.orDie);
    yield* threads
      .dispatch(pinCommand(row.enabled ? "thread.pin" : "thread.unpin", threadId, uuid))
      .pipe(Effect.ignore);
    if (previous !== undefined && previous.title !== title) {
      yield* threads
        .dispatch({
          type: "thread.metadata.update",
          commandId: CommandId.make(`t4:role-title:${uuid}`),
          threadId: ThreadId.make(threadId),
          title,
        })
        .pipe(Effect.ignore);
    }
  }
  yield* syncCheckIns(row, input.config, modelSelection);
  // Trigger states of triggers that were removed.
  const kept = new Set(input.config.triggers.map((trigger) => trigger.id));
  const before = previous === undefined ? undefined : yield* configOf(previous);
  for (const trigger of before?.triggers ?? []) {
    if (!kept.has(trigger.id))
      yield* store.deleteMeta(triggerKey(id, trigger.id)).pipe(Effect.ignore);
  }
  yield* syncCompaction;
  return { role: { ...row, config: input.config } } as const;
});

export const deleteRole = Effect.fn("t4.T4Roles.delete")(function* (id: string) {
  const store = yield* T4Store.T4Store;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const scheduled = yield* ScheduledTasks.ScheduledTaskService;
  const crypto = yield* SecureRandom.SecureRandom;
  const row = (yield* store.roles()).find((r) => r.id === id);
  if (row === undefined) return { error: "role not found" } as const;
  if (row.kind === RELEASE_MANAGER_KIND) {
    return { error: "a release manager can't be removed - releases depend on it" } as const;
  }
  for (const taskId of Object.values(yield* readCheckInIds(store, id))) {
    yield* scheduled.delete({ id: ScheduledTaskId.make(taskId) }).pipe(Effect.ignore);
  }
  if (row.threadId !== null) {
    const uuid = yield* crypto.uuidV4().pipe(Effect.orDie);
    yield* threads.dispatch(pinCommand("thread.unpin", row.threadId, uuid)).pipe(Effect.ignore);
  }
  yield* store.deleteMeta(`role-trigger:${id}:`).pipe(Effect.ignore);
  yield* store.deleteMeta(checkInsKey(id)).pipe(Effect.ignore);
  yield* store.deleteMeta(turnsKey(id)).pipe(Effect.ignore);
  yield* store.deleteRole(id);
  yield* syncCompaction;
  return { ok: true } as const;
});

export const setReleaseManagerCompaction = Effect.fn("t4.T4Roles.setRmCompaction")(function* (
  compactAtTokens: number | null,
) {
  const store = yield* T4Store.T4Store;
  const value =
    compactAtTokens !== null && compactAtTokens > 0 ? String(Math.round(compactAtTokens)) : "";
  yield* store.setMeta(RM_COMPACT_KEY, value);
  yield* syncCompaction;
  return yield* rmCompaction;
});

/** Rebuilds the per-thread compaction table from the roles and release managers. */
const syncCompaction = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const rms = yield* store.releaseManagers();
  const rows = yield* store.roles();
  const rm = yield* rmCompaction;
  const table = new Map<string, number>();
  const rmAt = rm.compactAtTokens ?? rm.defaultCompactAtTokens;
  if (rmAt !== null && rmAt > 0) for (const threadId of rms.values()) table.set(threadId, rmAt);
  for (const row of rows) {
    if (!row.enabled || row.threadId === null) continue;
    const config = yield* configOf(row);
    if (config?.compactAtTokens != null && config.compactAtTokens > 0) {
      table.set(row.threadId, config.compactAtTokens);
    }
  }
  setThreadCompaction(table);
}).pipe(Effect.ignoreCause({ log: true }));

const runProbe = Effect.fn("t4.T4Roles.runProbe")(function* (
  row: T4Store.T4RoleRow,
  trigger: RoleConfig["triggers"][number],
  previous: TriggerState,
  cwd: string,
  nowMs: number,
) {
  const processes = yield* ProcessRunner.ProcessRunner;
  const since = previous.since ?? iso(nowMs - trigger.everyMinutes * 60_000);
  const result = yield* processes
    .run({
      command: "bash",
      args: ["-c", trigger.command],
      cwd,
      env: {
        ...process.env,
        T4_PROBE_STATE: previous.state,
        T4_PROBE_SINCE: since,
        T4_ROLE_ID: row.id,
        T4_ROLE_KIND: row.kind,
        T4_TRIGGER_ID: trigger.id,
      },
      timeout: PROBE_TIMEOUT,
      timeoutBehavior: "timedOutResult",
      maxOutputBytes: 2_000_000,
      outputMode: "truncate",
    })
    .pipe(Effect.result);
  const failed = (error: string): TriggerState => ({
    ...previous,
    lastRunAt: iso(nowMs),
    lastOk: false,
    lastError: error.slice(-400),
    failures: previous.failures + 1,
  });
  if (Result.isFailure(result)) return { next: failed(String(result.failure)), added: 0 };
  const out = result.success;
  if (out.timedOut) return { next: failed("timed out after 60 s"), added: 0 };
  if (out.code !== 0) {
    return {
      next: failed(`exit ${out.code}: ${out.stderr.trim() || out.stdout.trim()}`),
      added: 0,
    };
  }
  const parsed = yield* decodeProbe(out.stdout.trim()).pipe(Effect.result);
  if (Result.isFailure(parsed))
    return { next: failed(`not the trigger JSON: ${out.stdout.trim().slice(0, 200)}`), added: 0 };
  const merged = mergeItems(previous, parsed.success.items, nowMs);
  return {
    next: {
      ...merged.next,
      state: parsed.success.state ?? previous.state,
      since: iso(nowMs),
      lastRunAt: iso(nowMs),
      lastOk: true,
      lastError: null,
      failures: 0,
    },
    added: merged.added,
  };
});

interface RoleRuntime {
  readonly row: T4Store.T4RoleRow;
  readonly config: RoleConfig;
  readonly cwd: string;
}

/** Runs one role's due triggers (or the one asked for) and delivers what is due. */
const tickRole = Effect.fn("t4.T4Roles.tickRole")(function* (
  role: RoleRuntime,
  options: { readonly forceTriggerId?: string; readonly forceCheckIn?: boolean },
) {
  const store = yield* T4Store.T4Store;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const delivery = yield* T4Delivery.T4Delivery;
  const now = yield* Clock.currentTimeMillis;
  const { row, config } = role;
  const states = new Map<string, TriggerState>();
  for (const trigger of config.triggers) {
    const previous = yield* readTriggerState(store, row.id, trigger.id);
    const forced = options.forceTriggerId === trigger.id;
    const due =
      forced ||
      (trigger.enabled && now - msOf(previous.lastRunAt) >= trigger.everyMinutes * 60_000 - 5_000);
    if (!due) {
      states.set(trigger.id, previous);
      continue;
    }
    const { next } = yield* runProbe(row, trigger, previous, role.cwd, now);
    states.set(trigger.id, next);
    yield* writeTriggerState(store, row.id, trigger.id, next);
  }
  if (row.threadId === null) return 0;
  const shell = yield* threads
    .getThreadShell(ThreadId.make(row.threadId))
    .pipe(Effect.orElseSucceed(() => null));
  if (shell === null || shell.deletedAt !== null) return 0;

  // Failing triggers: one note after a few failures in a row, at most every 6 h.
  for (const trigger of config.triggers) {
    const state = states.get(trigger.id)!;
    if (state.failures < FAIL_NOTE_AFTER || now - msOf(state.lastFailNoteAt) < FAIL_NOTE_EVERY_MS)
      continue;
    yield* delivery
      .deliver({
        target: shell,
        text: `t4: your trigger **${trigger.label}** (\`${trigger.command}\`) failed ${state.failures} times in a row: ${state.lastError ?? "no output"}. If it needs a key or a fix only the user can make, say so in one Update card with the exact change (dashboard: Settings -> Roles); otherwise end your turn in one line.`,
        force: true,
        patient: true,
        createdBy: "system",
        creationSource: "server",
      })
      .pipe(Effect.ignore);
    const noted = { ...state, lastFailNoteAt: iso(now) };
    states.set(trigger.id, noted);
    yield* writeTriggerState(store, row.id, trigger.id, noted);
  }

  if (options.forceCheckIn === true) {
    yield* delivery
      .deliver({
        target: shell,
        text: `Check-in requested from the dashboard (${row.title}). Do your regular check-in now.`,
        force: true,
        patient: true,
        createdBy: "user",
        creationSource: "web",
      })
      .pipe(Effect.ignore);
  }

  const forced = options.forceTriggerId !== undefined;
  const ready = config.triggers.filter((trigger) => {
    const state = states.get(trigger.id)!;
    if (state.pending.length === 0) return false;
    return forced || now - msOf(state.pendingSince) >= trigger.batchMinutes * 60_000;
  });
  if (ready.length === 0) return 0;
  if (!forced) {
    if (isRunning(shell)) return 0;
    if (inQuietHours(config.quietHours, now)) return 0;
    if ((yield* turnsToday(store, row.id, now)) >= config.maxTriggerTurnsPerDay) return 0;
  }
  const batches = ready.map((trigger) => ({
    label: trigger.label,
    items: states.get(trigger.id)!.pending,
  }));
  const delivered = yield* delivery
    .deliver({
      target: shell,
      text: triggerMessage(batches, row),
      force: true,
      patient: true,
      createdBy: "system",
      creationSource: "server",
    })
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );
  if (!delivered) return 0;
  let count = 0;
  for (const trigger of ready) {
    const state = states.get(trigger.id)!;
    count += state.pending.length;
    yield* writeTriggerState(store, row.id, trigger.id, {
      ...state,
      pending: [],
      pendingSince: null,
      lastFiredAt: iso(now),
    });
  }
  const today = pacificParts(now).day;
  const turns = yield* turnsToday(store, row.id, now);
  yield* store.setMeta(turnsKey(row.id), `${today} ${turns + 1}`).pipe(Effect.ignore);
  yield* Effect.logInfo("t4: role trigger delivered", { roleId: row.id, items: count });
  return count;
});

const runtimes = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const projects = yield* Project.ProjectService;
  const out: Array<RoleRuntime> = [];
  for (const row of yield* store.roles()) {
    if (!row.enabled) continue;
    const config = yield* configOf(row);
    if (config === undefined) continue;
    const project = Option.getOrUndefined(
      yield* projects
        .getById(ProjectId.make(row.projectId))
        .pipe(Effect.orElseSucceed(() => Option.none())),
    );
    if (project === undefined) continue;
    out.push({ row, config, cwd: project.workspaceRoot });
  }
  return out;
});

/**
 * Every project's release manager is a standing role: a row bound to its recorded thread, made with
 * the release manager's compaction point and a failed-deploy trigger, kept on its current thread.
 */
const ensureReleaseManagerRoles = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverConfig = yield* T4Config.T4ServerConfig;
  const now = yield* Clock.currentTimeMillis;
  const rms = yield* store.releaseManagers();
  const rows = yield* store.roles();
  const rm = yield* rmCompaction;
  for (const [projectId, threadId] of rms) {
    const existing = rows.find((r) => r.kind === RELEASE_MANAGER_KIND && r.projectId === projectId);
    if (existing !== undefined) {
      if (existing.threadId !== threadId || !existing.enabled) {
        yield* store.upsertRole({ ...existing, threadId, enabled: true, updatedAt: iso(now) });
      }
      continue;
    }
    const shell = yield* threads
      .getThreadShell(ThreadId.make(threadId))
      .pipe(Effect.orElseSucceed(() => null));
    const config: RoleConfig = {
      brief: "",
      model: serverConfig.releaseManagerModel,
      compactAtTokens: rm.compactAtTokens ?? rm.defaultCompactAtTokens,
      checkIns: [],
      triggers: [RM_DEPLOY_TRIGGER],
      quietHours: null,
      maxTriggerTurnsPerDay: 24,
    };
    yield* store.upsertRole({
      id: rmRoleId(projectId),
      kind: RELEASE_MANAGER_KIND,
      title: shell?.title ?? serverConfig.releaseManagerTitlePrefix,
      projectId,
      threadId,
      enabled: true,
      configJson: yield* encodeConfig(config).pipe(Effect.orDie),
      createdAt: iso(now),
      updatedAt: iso(now),
    });
    yield* Effect.logInfo("t4: release manager is now a standing role", { projectId });
  }
}).pipe(Effect.ignoreCause({ log: true }));

/** Every minute: release managers' roles, the compaction table, then each enabled role's due triggers. */
export const sweep = Effect.gen(function* () {
  yield* ensureReleaseManagerRoles;
  yield* syncCompaction;
  const roles = yield* runtimes;
  yield* Effect.forEach(
    roles,
    (role) => tickRole(role, {}).pipe(Effect.ignoreCause({ log: true })),
    { concurrency: 4, discard: true },
  );
}).pipe(Effect.ignoreCause({ log: true }));

export const runRole = Effect.fn("t4.T4Roles.run")(function* (id: string, triggerId?: string) {
  const roles = yield* runtimes;
  const role = roles.find((r) => r.row.id === id);
  if (role === undefined) return { error: "role not found or turned off" } as const;
  if (triggerId !== undefined && !role.config.triggers.some((t) => t.id === triggerId)) {
    return { error: "trigger not found" } as const;
  }
  const delivered = yield* tickRole(
    role,
    triggerId === undefined ? { forceCheckIn: true } : { forceTriggerId: triggerId },
  );
  return { ok: true, delivered } as const;
});

/** For `/api/t4/state`: thread id -> its role. */
export const standingRolesForState = Effect.gen(function* () {
  const store = yield* T4Store.T4Store;
  const out: Record<string, { roleId: string; kind: string; title: string }> = {};
  for (const row of yield* store.roles()) {
    if (row.enabled && row.threadId !== null) {
      out[row.threadId] = { roleId: row.id, kind: row.kind, title: row.title };
    }
  }
  return out;
}).pipe(Effect.orElseSucceed(() => ({})));
