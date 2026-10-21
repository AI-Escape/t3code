/**
 * t4 fork: the model a launch gets when it names none - the client's own
 * default (T3's `defaultModelSelection`, with the project's override in
 * `projectSettingsOverrides`), the same selection T3's UI pre-fills for a new
 * chat. The t4 dashboard edits it per client. Upstream's launch tool inherits
 * the launching thread's model instead, so a Codex release manager spawned
 * Codex threads into a client whose default is Claude.
 */
import type { ModelSelection, ProjectId } from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";

export const clientDefaultModelSelection = Effect.fn("t4.clientDefaultModelSelection")(function* (
  projectId: ProjectId,
) {
  const service = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (Option.isNone(service)) return undefined;
  const settings = yield* service.value.getSettings.pipe(Effect.option);
  if (Option.isNone(settings)) return undefined;
  const selection: ModelSelection | null | undefined = resolveProjectSettings(
    settings.value,
    projectId,
  ).settings.defaultModelSelection;
  return selection ?? undefined;
});
