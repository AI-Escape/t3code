/**
 * t4 fork: one-time import of the old thread tools' state
 * (`~/.config/t3-agents/state/*.json`) into the fork, on the first start
 * after migration. The JSON files are left in place as a backup.
 *
 *   handoffs.json          -> t4_handoffs (open and settled)
 *   notices.json           -> t4_notices
 *   release-managers.json  -> t4_release_managers
 *   settle-requests.json   -> t4_settle_requests
 *   wakes.json             -> scheduled tasks posted into each thread
 *                             (at/in -> once, every -> interval, cron -> cron)
 * and each thread whose title or branch names an issue (t4's rule until
 * now) gets that issue linked, so ownership carries over.
 */
import { type ModelSelection, type ProjectId, type ThreadId } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as T4Config from "./T4Config.ts";
import * as T4Ledger from "./T4Ledger.ts";
import * as T4Store from "./T4Store.ts";
import { issueIdIn } from "./T4Threads.ts";
import { wakePrompt } from "./wakes.ts";

const IMPORT_MARKER = "legacy-state-import";

const LegacyHandoff = Schema.Struct({
  id: Schema.String,
  kind: Schema.optional(Schema.String),
  from: Schema.String,
  fromTitle: Schema.optional(Schema.String),
  to: Schema.String,
  project: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.String),
  createdAt: Schema.String,
  updatedAt: Schema.optional(Schema.NullOr(Schema.String)),
  settledAt: Schema.optional(Schema.NullOr(Schema.String)),
});
const LegacyWake = Schema.Struct({
  id: Schema.Number,
  thread: Schema.String,
  threadTitle: Schema.optional(Schema.String),
  note: Schema.String,
  schedule: Schema.Struct({
    kind: Schema.String,
    spec: Schema.String,
    seconds: Schema.optional(Schema.Number),
  }),
  due: Schema.String,
  createdAt: Schema.String,
});

const decodeHandoffs = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Array(LegacyHandoff)),
);
const decodeIds = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeMap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.String)),
);
const decodeWakes = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ wakes: Schema.Array(LegacyWake) })),
);

const readJson = <A>(
  fileSystem: FileSystem.FileSystem,
  file: string,
  decode: (text: string) => Effect.Effect<A, Schema.SchemaError>,
) => fileSystem.readFileString(file).pipe(Effect.flatMap(decode), Effect.option);

export const run = Effect.gen(function* () {
  const config = yield* T4Config.T4ServerConfig;
  const store = yield* T4Store.T4Store;
  if ((yield* store.meta(IMPORT_MARKER)) !== undefined) return;
  const ledger = yield* T4Ledger.T4Ledger;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const world = yield* ledger.world();
  const counts = {
    handoffs: 0,
    notices: 0,
    releaseManagers: 0,
    settleRequests: 0,
    wakes: 0,
    issues: 0,
  };
  const dir = config.legacyStateDir;

  if (dir !== null) {
    const file = (name: string) => path.join(dir, name);
    const handoffs = yield* readJson(fileSystem, file("handoffs.json"), decodeHandoffs);
    for (const h of handoffs._tag === "Some" ? handoffs.value : []) {
      yield* store.insertHandoffRow({
        id: h.id,
        kind: h.kind === "spawn" ? "spawn" : "handoff",
        fromThreadId: h.from,
        fromTitle: h.fromTitle ?? world.byId.get(h.from)?.title ?? h.from,
        toThreadId: h.to,
        projectId: h.project ?? world.byId.get(h.to)?.projectId ?? "",
        summary: h.summary ?? "",
        createdAt: h.createdAt,
        updatedAt: h.updatedAt ?? null,
        settledAt: h.settledAt ?? null,
      });
      counts.handoffs++;
    }
    const notices = yield* readJson(fileSystem, file("notices.json"), decodeIds);
    for (const id of notices._tag === "Some" ? notices.value : []) {
      yield* store.addNotice(id);
      counts.notices++;
    }
    const rms = yield* readJson(fileSystem, file("release-managers.json"), decodeMap);
    for (const [projectId, threadId] of Object.entries(rms._tag === "Some" ? rms.value : {})) {
      yield* store.setReleaseManager(projectId, threadId);
      counts.releaseManagers++;
    }
    const settles = yield* readJson(fileSystem, file("settle-requests.json"), decodeMap);
    for (const [threadId, at] of Object.entries(settles._tag === "Some" ? settles.value : {})) {
      yield* store.setSettleRequest(threadId, at);
      counts.settleRequests++;
    }
    const wakes = yield* readJson(fileSystem, file("wakes.json"), decodeWakes);
    const scheduledTasks = yield* Effect.serviceOption(ScheduledTasks.ScheduledTaskService);
    const now = yield* Clock.currentTimeMillis;
    const tasks = scheduledTasks._tag === "Some" ? scheduledTasks.value : undefined;
    for (const w of wakes._tag === "Some" && tasks !== undefined ? wakes.value.wakes : []) {
      if (tasks === undefined) break;
      const thread = world.byId.get(w.thread);
      if (thread === undefined || thread.archivedAt !== null) continue;
      const recurring = w.schedule.kind === "every" || w.schedule.kind === "cron";
      const schedule =
        w.schedule.kind === "cron"
          ? { type: "cron" as const, expression: w.schedule.spec }
          : w.schedule.kind === "every"
            ? {
                type: "interval" as const,
                everyMs: Math.max(60_000, (w.schedule.seconds ?? 300) * 1000),
              }
            : {
                type: "once" as const,
                at:
                  Date.parse(w.due) > now
                    ? w.due
                    : DateTime.formatIso(DateTime.makeUnsafe(now + 60_000)),
              };
      const created = DateTime.make(w.createdAt);
      yield* tasks
        .upsert({
          title: (w.note.split("\n")[0] ?? "Wake").slice(0, 80) || "Wake",
          prompt: wakePrompt({
            note: w.note,
            scheduledAtLabel:
              created._tag === "Some"
                ? `${DateTime.formatIso(created.value).slice(0, 16).replace("T", " ")} UTC`
                : w.createdAt,
            byTitle: undefined,
            recurring,
          }),
          enabled: true,
          schedule,
          projectId: thread.projectId as ProjectId,
          threadId: thread.id as ThreadId,
          workspaceStrategy: { type: "root" },
          modelSelection: thread.modelSelection as ModelSelection,
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.ignoreCause({ log: true }));
      counts.wakes++;
    }
  }

  // Ownership by name, as t4 inferred it until now.
  const linkedAt = DateTime.formatIso(DateTime.makeUnsafe(yield* Clock.currentTimeMillis));
  for (const thread of world.threads) {
    const identifier = issueIdIn(thread.title) ?? issueIdIn(thread.branch);
    if (identifier === null) continue;
    if (
      yield* store.linkIssue({
        threadId: thread.id,
        provider: "linear",
        identifier,
        url: null,
        title: null,
        linkedAt,
      })
    ) {
      counts.issues++;
    }
  }

  yield* store.setMeta(IMPORT_MARKER, linkedAt);
  yield* Effect.logInfo("t4: imported legacy thread-tools state", counts);
}).pipe(Effect.ignoreCause({ log: true }));
