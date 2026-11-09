import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ScheduledTasks from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as T4Schedules from "./T4Schedules.ts";
import * as T4Store from "./T4Store.ts";

const sol = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };

const harness = () => {
  const meta = new Map<string, string>();
  const tasks = new Map<string, Record<string, unknown>>();
  const services = (defaultModel: typeof sol) =>
    Layer.mergeAll(
      Layer.mock(T4Store.T4Store)({
        meta: (key: string) => Effect.succeed(meta.get(key)),
        setMeta: (key: string, value: string) => Effect.sync(() => void meta.set(key, value)),
      }),
      Layer.mock(ScheduledTasks.ScheduledTaskService)({
        list: () => Effect.sync(() => ({ tasks: [...tasks.values()] }) as never),
        upsert: (input) =>
          Effect.sync(() => {
            const id = input.id ?? `task-${tasks.size + 1}`;
            const task = { ...input, id, threadId: input.threadId ?? null };
            tasks.set(id, task);
            return { task } as never;
          }),
      }),
      ServerSettings.layerTest({ defaultModelSelection: defaultModel }),
    );
  const run = <A, E>(
    effect: Effect.Effect<
      A,
      E,
      T4Store.T4Store | ScheduledTasks.ScheduledTaskService | ServerSettings.ServerSettingsService
    >,
    defaultModel = sol,
  ) => effect.pipe(Effect.provide(services(defaultModel)));
  return { tasks, run };
};

const daily = {
  projectId: "project-app",
  title: "Sentry triage",
  prompt: "Load the `sentry-triage` skill and follow it.",
  enabled: true,
  cron: "0 7 * * *",
};

describe("t4 scheduled sessions", () => {
  it.effect(
    "saves a session on the client's default model and follows the default when it changes",
    () =>
      Effect.gen(function* () {
        const h = harness();
        const saved = yield* h.run(T4Schedules.saveSchedule(daily));
        expect("task" in saved).toBe(true);
        const listed = yield* h.run(T4Schedules.listSchedules());
        expect(listed[0]).toMatchObject({
          cron: "0 7 * * *",
          defaultModel: true,
          modelSelection: sol,
        });
        expect([...h.tasks.values()][0]).toMatchObject({
          threadId: null,
          workspaceStrategy: { type: "root" },
          schedule: { type: "cron", expression: "0 7 * * *" },
        });

        yield* h.run(T4Schedules.syncDefaultModels, opus);
        expect((yield* h.run(T4Schedules.listSchedules()))[0]!.modelSelection).toMatchObject(opus);
      }),
  );

  it.effect("keeps a chosen model, and forgets a deleted schedule", () =>
    Effect.gen(function* () {
      const h = harness();
      yield* h.run(T4Schedules.saveSchedule({ ...daily, modelSelection: opus }));
      yield* h.run(T4Schedules.syncDefaultModels, sol);
      const [task] = yield* h.run(T4Schedules.listSchedules());
      expect(task).toMatchObject({ defaultModel: false, modelSelection: opus });
    }),
  );
});
