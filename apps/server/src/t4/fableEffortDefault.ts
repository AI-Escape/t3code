/**
 * t4 fork: Fable's effort defaults to high (AI-78). Upstream's manifest says medium and replaces
 * the bundled one when newer, so this applies to every manifest T3 loads (bundled, cached, fetched).
 */
import type { ModelManifestData } from "../provider/ModelManifest.ts";
import { isFableModel } from "./claudeAccounts.ts";

const CLAUDE_PROVIDER = "claudeAgent";
const T4_FABLE_DEFAULT_EFFORT = "high";

type Profile = ModelManifestData["providers"] extends infer P
  ? P extends Readonly<Record<string, { readonly profiles: Readonly<Record<string, infer R>> }>>
    ? R
    : never
  : never;
type Descriptor = NonNullable<NonNullable<Profile["capabilities"]>["optionDescriptors"]>[number];

const withDefault = (descriptor: Descriptor, effort: string): Descriptor =>
  descriptor.id !== "effort" ||
  descriptor.type !== "select" ||
  !descriptor.options.some((option) => option.id === effort)
    ? descriptor
    : {
        ...descriptor,
        options: descriptor.options.map(({ isDefault: _isDefault, ...option }) =>
          option.id === effort ? { ...option, isDefault: true } : option,
        ),
      };

export function applyT4FableEffortDefault(
  manifest: ModelManifestData,
  effort: string = T4_FABLE_DEFAULT_EFFORT,
): ModelManifestData {
  const catalog = manifest.providers?.[CLAUDE_PROVIDER];
  if (!catalog) return manifest;
  const fableProfiles = new Set(
    catalog.models.flatMap((model) =>
      isFableModel(model.slug) && model.profile !== undefined ? [model.profile] : [],
    ),
  );
  if (fableProfiles.size === 0) return manifest;
  const profiles = Object.fromEntries(
    Object.entries(catalog.profiles).map(([name, profile]): [string, Profile] => {
      const capabilities = profile.capabilities;
      const descriptors = capabilities?.optionDescriptors;
      if (!fableProfiles.has(name) || !capabilities || !descriptors) return [name, profile];
      return [
        name,
        {
          ...profile,
          capabilities: {
            ...capabilities,
            optionDescriptors: descriptors.map((d) => withDefault(d, effort)),
          },
        },
      ];
    }),
  );
  return {
    ...manifest,
    providers: { ...manifest.providers, [CLAUDE_PROVIDER]: { ...catalog, profiles } },
  };
}
