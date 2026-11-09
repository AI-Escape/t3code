import { describe, expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../serverSettings.ts";
import * as T4Config from "./T4Config.ts";
import { unlistedModelRefusal } from "./T4ModelPolicy.ts";

const projectId = ProjectId.make("project-policy");
const codex = ProviderInstanceId.make("codex");
const sol = { instanceId: codex, model: "gpt-6.1-sol" };
const opus = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "claude-opus-5-5" };
const terra = { instanceId: codex, model: "gpt-6.1-terra" };

const config: T4Config.T4ServerConfigShape = {
  ...T4Config.defaultT4ServerConfig,
  releaseManagerModel: sol,
  launchPresets: { codex: sol, claude: opus },
};

const run = (input: Parameters<typeof unlistedModelRefusal>[0], withConfig = true) => {
  const effect = unlistedModelRefusal(input).pipe(
    Effect.provide(ServerSettings.layerTest({ defaultModelSelection: sol })),
  );
  return withConfig ? effect.pipe(Effect.provideService(T4Config.T4ServerConfig, config)) : effect;
};

describe("t4 unlistedModelRefusal", () => {
  it.effect("allows the client's default, the presets and the caller's own model", () =>
    Effect.gen(function* () {
      expect(yield* run({ projectId, selection: sol })).toBeUndefined();
      expect(yield* run({ projectId, selection: opus })).toBeUndefined();
      expect(yield* run({ projectId, selection: terra, callerSelection: terra })).toBeUndefined();
    }),
  );

  it.effect("refuses a model the user never chose, naming the ones they did", () =>
    Effect.gen(function* () {
      const refusal = yield* run({
        projectId,
        selection: terra,
        callerSelection: opus,
        byPreset: true,
      });
      expect(refusal).toContain("gpt-6.1-terra (codex) is not one of the models the user set");
      expect(refusal).toContain("the client's default gpt-6.1-sol (codex), by naming no model");
      expect(refusal).toContain('modelPreset "claude" for claude-opus-5-5 (claudeAgent)');
      expect(refusal).toContain("your own model claude-opus-5-5 (claudeAgent)");
    }),
  );

  it.effect("does nothing without t4's config", () =>
    Effect.gen(function* () {
      expect(yield* run({ projectId, selection: terra }, false)).toBeUndefined();
    }),
  );
});
