/**
 * t4 fork: agents launch and delegate only on models the user chose for the
 * client - its default (T4DefaultModel), the launch presets, the release
 * manager's model, or the calling thread's own. Upstream's tools invite an
 * agent to pick any catalog model, and a PM told to build a product feature
 * on GPT-6.1 Terra launched all six of its workstreams on Terra instead of
 * the client's default Sol (ai-escape AI-27, 2026-10-29).
 */
import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as T4Config from "./T4Config.ts";
import * as T4DefaultModel from "./T4DefaultModel.ts";

type ModelRef = Pick<ModelSelection, "instanceId" | "model">;

const describe = (selection: ModelRef) => `${selection.model} (${selection.instanceId})`;

/** The refusal for an agent-chosen model outside the user's, or undefined when it is allowed. */
export const unlistedModelRefusal = Effect.fn("t4.unlistedModelRefusal")(function* (input: {
  readonly projectId: ProjectId;
  readonly selection: ModelRef;
  readonly callerSelection?: ModelRef | undefined;
  /** t3_thread_launch takes presets by name; delegate_task and create_threads take a model. */
  readonly byPreset?: boolean;
}) {
  const config = yield* Effect.serviceOption(T4Config.T4ServerConfig);
  if (Option.isNone(config)) return undefined;
  const clientDefault = yield* T4DefaultModel.clientDefaultModelSelection(input.projectId);
  const presets = Object.entries(config.value.launchPresets);
  const allowed: ModelRef[] = [
    ...(clientDefault === undefined ? [] : [clientDefault]),
    ...presets.map(([, selection]) => selection),
    ...(config.value.releaseManagerModel === null ? [] : [config.value.releaseManagerModel]),
    ...(input.callerSelection === undefined ? [] : [input.callerSelection]),
  ];
  if (
    allowed.some(
      (entry) =>
        entry.instanceId === input.selection.instanceId && entry.model === input.selection.model,
    )
  )
    return undefined;
  const choices = [
    ...(clientDefault === undefined
      ? []
      : [
          input.byPreset === true
            ? `the client's default ${describe(clientDefault)}, by naming no model`
            : `the client's default ${describe(clientDefault)}`,
        ]),
    ...presets.map(([name, selection]) =>
      input.byPreset === true
        ? `modelPreset "${name}" for ${describe(selection)}`
        : describe(selection),
    ),
    ...(input.callerSelection === undefined
      ? []
      : [`your own model ${describe(input.callerSelection)}`]),
  ];
  return [
    `${describe(input.selection)} is not one of the models the user set for agents on this client.`,
    `Use ${choices.join(", or ")}.`,
    "A model the product you are building calls is not a model for the agents building it.",
    "If the user wants agents on another model, they change the client's default.",
  ].join(" ");
});
