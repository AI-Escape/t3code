/**
 * t4 fork: whether a stale Claude session is offered compaction before it
 * resumes (`offerResumeCompaction` in settings.json, on unless turned off).
 * Claude Code asks its own "Compact it before continuing?" question when a
 * large session comes back after its prompt cache expired; with the setting
 * off the adapter answers "keep full history" instead of putting the
 * question in front of the user, and the web composer drops its Compact chip.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";

export const offerResumeCompaction = Effect.fn("t4.offerResumeCompaction")(function* () {
  const service = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  if (Option.isNone(service)) return true;
  const settings = yield* service.value.getSettings.pipe(Effect.option);
  return Option.isNone(settings) ? true : settings.value.offerResumeCompaction;
});
