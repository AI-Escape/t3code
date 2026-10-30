import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

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
  return Effect.runPromise(
    withConfig ? effect.pipe(Effect.provideService(T4Config.T4ServerConfig, config)) : effect,
  );
};

describe("t4 unlistedModelRefusal", () => {
  it("allows the client's default, the presets and the caller's own model", async () => {
    expect(await run({ projectId, selection: sol })).toBeUndefined();
    expect(await run({ projectId, selection: opus })).toBeUndefined();
    expect(await run({ projectId, selection: terra, callerSelection: terra })).toBeUndefined();
  });

  it("refuses a model the user never chose, naming the ones they did", async () => {
    const refusal = await run({
      projectId,
      selection: terra,
      callerSelection: opus,
      byPreset: true,
    });
    expect(refusal).toContain("gpt-6.1-terra (codex) is not one of the models the user set");
    expect(refusal).toContain("the client's default gpt-6.1-sol (codex), by naming no model");
    expect(refusal).toContain('modelPreset "claude" for claude-opus-5-5 (claudeAgent)');
    expect(refusal).toContain("your own model claude-opus-5-5 (claudeAgent)");
  });

  it("does nothing without t4's config", async () => {
    expect(await run({ projectId, selection: terra }, false)).toBeUndefined();
  });
});
