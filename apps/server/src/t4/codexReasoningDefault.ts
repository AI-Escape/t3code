/**
 * t4 fork: T3 pre-selects the effort Codex's `model/list` calls default (`low` for some models),
 * though t4 launches Codex at high. With `T4_CODEX_DEFAULT_REASONING_EFFORT=high`, each Codex
 * model that supports that effort offers it as its default; others keep Codex's.
 */
import type { ServerProviderModel } from "@t3tools/contracts";

export function codexReasoningDefaultOverride(env: NodeJS.ProcessEnv | undefined): string | null {
  const value = env?.T4_CODEX_DEFAULT_REASONING_EFFORT?.trim();
  return value ? value : null;
}

export function applyT4CodexReasoningDefault(
  models: ReadonlyArray<ServerProviderModel>,
  effort: string | null,
): ReadonlyArray<ServerProviderModel> {
  if (effort === null) return models;
  return models.map((model) => {
    const descriptors = model.capabilities?.optionDescriptors;
    const reasoning = descriptors?.find((d) => d.id === "reasoningEffort");
    if (
      !model.capabilities ||
      !descriptors ||
      !reasoning ||
      reasoning.type !== "select" ||
      !reasoning.options.some((option) => option.id === effort)
    ) {
      return model;
    }
    return {
      ...model,
      capabilities: {
        ...model.capabilities,
        optionDescriptors: descriptors.map((d) =>
          d !== reasoning || d.type !== "select"
            ? d
            : {
                ...d,
                options: d.options.map(({ isDefault: _isDefault, ...option }) =>
                  option.id === effort ? { ...option, isDefault: true } : option,
                ),
                currentValue: effort,
              },
        ),
      },
    };
  });
}
