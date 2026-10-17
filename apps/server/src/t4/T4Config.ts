/**
 * t4 fork: configuration for t4's session tooling, read once at startup from
 * the JSON file named by `T4_SERVER_CONFIG` (absent: defaults below). Kept
 * out of T3's settings schema so upstream settings changes never conflict.
 */
import { ModelSelection } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

export const T4WorktreeNaming = Schema.Literals(["branch", "issueId"]);

export const T4ServerConfigJson = Schema.Struct({
  /** Release managers: thread title prefix and the selection they always run on. */
  releaseManager: Schema.optional(
    Schema.Struct({
      titlePrefix: Schema.optional(Schema.String),
      model: Schema.optional(Schema.NullOr(ModelSelection)),
    }),
  ),
  /** `issueId`: worktrees at `<worktrees>/<issue id or slug>` (t4); `branch`: upstream. */
  worktreeNaming: Schema.optional(T4WorktreeNaming),
  /** Named model selections for launches (the dashboard's Linear spawn presets). */
  launchPresets: Schema.optional(Schema.Record(Schema.String, ModelSelection)),
  stallRecovery: Schema.optional(
    Schema.Struct({
      enabled: Schema.optional(Schema.Boolean),
      silenceMinutes: Schema.optional(Schema.Number),
      repeatHours: Schema.optional(Schema.Number),
    }),
  ),
  /** Directory of the old thread tools' JSON state, imported once into t4's tables. */
  legacyStateDir: Schema.optional(Schema.NullOr(Schema.String)),
  /** Script run in a worktree to retire its dev footprint (glob, relative to the worktree). */
  devRetireGlob: Schema.optional(Schema.NullOr(Schema.String)),
});
export type T4ServerConfigJson = typeof T4ServerConfigJson.Type;

export interface T4ServerConfigShape {
  readonly releaseManagerTitlePrefix: string;
  readonly releaseManagerModel: ModelSelection | null;
  readonly worktreeNaming: "branch" | "issueId";
  readonly launchPresets: Readonly<Record<string, ModelSelection>>;
  readonly stallRecovery: {
    readonly enabled: boolean;
    readonly silenceMinutes: number;
    readonly repeatHours: number;
  };
  readonly legacyStateDir: string | null;
  readonly devRetireGlob: string | null;
}

export const defaultT4ServerConfig: T4ServerConfigShape = {
  releaseManagerTitlePrefix: "Release manager",
  releaseManagerModel: null,
  worktreeNaming: "branch",
  launchPresets: {},
  stallRecovery: { enabled: false, silenceMinutes: 15, repeatHours: 6 },
  legacyStateDir: null,
  devRetireGlob: null,
};

export function resolveT4ServerConfig(json: T4ServerConfigJson): T4ServerConfigShape {
  const d = defaultT4ServerConfig;
  return {
    releaseManagerTitlePrefix: json.releaseManager?.titlePrefix ?? d.releaseManagerTitlePrefix,
    releaseManagerModel: json.releaseManager?.model ?? d.releaseManagerModel,
    worktreeNaming: json.worktreeNaming ?? d.worktreeNaming,
    launchPresets: json.launchPresets ?? d.launchPresets,
    stallRecovery: {
      enabled: json.stallRecovery?.enabled ?? d.stallRecovery.enabled,
      silenceMinutes: json.stallRecovery?.silenceMinutes ?? d.stallRecovery.silenceMinutes,
      repeatHours: json.stallRecovery?.repeatHours ?? d.stallRecovery.repeatHours,
    },
    legacyStateDir: json.legacyStateDir ?? d.legacyStateDir,
    devRetireGlob: json.devRetireGlob ?? d.devRetireGlob,
  };
}

export class T4ServerConfig extends Context.Service<T4ServerConfig, T4ServerConfigShape>()(
  "t3/t4/T4Config/T4ServerConfig",
) {}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(T4ServerConfigJson));

export const layer = Layer.effect(
  T4ServerConfig,
  Effect.gen(function* () {
    const path = process.env.T4_SERVER_CONFIG?.trim();
    if (!path) return defaultT4ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const text = yield* fileSystem.readFileString(path).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("t4 server config unreadable; using defaults", { path, cause }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    if (text === undefined) return defaultT4ServerConfig;
    const json = yield* decodeConfig(text).pipe(
      Effect.tapError((cause) =>
        Effect.logWarning("t4 server config invalid; using defaults", { path, cause }),
      ),
      Effect.orElseSucceed(() => ({}) as T4ServerConfigJson),
    );
    return resolveT4ServerConfig(json);
  }),
);

/** A fixed config, for tests. */
export const layerTest = (config: Partial<T4ServerConfigShape> = {}) =>
  Layer.succeed(T4ServerConfig, { ...defaultT4ServerConfig, ...config });
