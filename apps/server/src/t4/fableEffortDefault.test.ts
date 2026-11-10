import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind } from "@t3tools/contracts";

import bundledManifestJson from "../provider/model-manifest.json" with { type: "json" };
import {
  BUNDLED_MODEL_MANIFEST,
  resolveProviderCatalog,
  type ModelManifestData,
} from "../provider/ModelManifest.ts";
import {
  resolveClaudeCatalogEffort,
  resolveClaudeModelCatalog,
} from "../provider/ClaudeModelCatalog.ts";
import { applyT4FableEffortDefault } from "./fableEffortDefault.ts";

const CLAUDE = ProviderDriverKind.make("claudeAgent");
const effortOf = (manifest: ModelManifestData, model: string) =>
  resolveClaudeCatalogEffort(
    resolveClaudeModelCatalog(resolveProviderCatalog(manifest, CLAUDE) ?? undefined),
    model,
    undefined,
  );

describe("t4 Fable effort default", () => {
  it("defaults Fable to high in the manifest T3 loads; other models keep theirs", () => {
    // Upstream's file marks medium.
    assert.strictEqual(
      effortOf(bundledManifestJson as unknown as ModelManifestData, "claude-fable-5-2"),
      "medium",
    );
    assert.strictEqual(effortOf(BUNDLED_MODEL_MANIFEST, "claude-fable-5-2"), "high");
    assert.strictEqual(effortOf(BUNDLED_MODEL_MANIFEST, "fable"), "high");
    assert.strictEqual(
      effortOf(BUNDLED_MODEL_MANIFEST, "claude-opus-5-5"),
      effortOf(bundledManifestJson as unknown as ModelManifestData, "claude-opus-5-5"),
    );
    // A chosen effort still wins.
    assert.strictEqual(
      resolveClaudeCatalogEffort(
        resolveClaudeModelCatalog(
          resolveProviderCatalog(BUNDLED_MODEL_MANIFEST, CLAUDE) ?? undefined,
        ),
        "claude-fable-5-2",
        "low",
      ),
      "low",
    );
  });

  it("leaves a manifest without Claude untouched", () => {
    const manifest = { ...BUNDLED_MODEL_MANIFEST, providers: {} };
    assert.strictEqual(applyT4FableEffortDefault(manifest), manifest);
  });
});
