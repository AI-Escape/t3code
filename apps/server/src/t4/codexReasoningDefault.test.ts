import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  applyT4CodexReasoningDefault,
  codexReasoningDefaultOverride,
} from "./codexReasoningDefault.ts";

const model = (
  slug: string,
  efforts: ReadonlyArray<string>,
  codexDefault: string,
): ServerProviderModel => ({
  slug,
  name: slug,
  isCustom: false,
  capabilities: {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: efforts.map((id) =>
          id === codexDefault ? { id, label: id, isDefault: true } : { id, label: id },
        ),
        currentValue: codexDefault,
      },
    ],
  },
});

const reasoning = (m: ServerProviderModel) => {
  const d = m.capabilities?.optionDescriptors?.find((x) => x.id === "reasoningEffort");
  return d && d.type === "select"
    ? { defaults: d.options.filter((o) => o.isDefault).map((o) => o.id), current: d.currentValue }
    : null;
};

describe("t4 Codex reasoning default", () => {
  it("makes the configured effort the default where the model supports it", () => {
    const [sol, old] = applyT4CodexReasoningDefault(
      [
        model("gpt-6.1-sol", ["low", "medium", "high"], "low"),
        model("old", ["low", "medium"], "medium"),
      ],
      "high",
    );
    assert.deepStrictEqual(reasoning(sol!), { defaults: ["high"], current: "high" });
    assert.deepStrictEqual(reasoning(old!), { defaults: ["medium"], current: "medium" });
  });

  it("leaves Codex's defaults alone without the variable", () => {
    assert.equal(codexReasoningDefaultOverride({}), null);
    assert.equal(
      codexReasoningDefaultOverride({ T4_CODEX_DEFAULT_REASONING_EFFORT: " high " }),
      "high",
    );
    const models = [model("gpt-6.1-sol", ["low", "high"], "low")];
    assert.strictEqual(applyT4CodexReasoningDefault(models, null), models);
  });
});
