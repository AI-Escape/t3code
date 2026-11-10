/**
 * t4 fork: listed accounts (`T4_CLAUDE_ACCOUNTS_FILE`/`T4_CLAUDE_ACCOUNTS`) go first as
 * `CLAUDE_CODE_OAUTH_TOKEN`; used-up marks persist in `state.json`, an unlisted account counts as
 * used up, and Fable's own weekly limit (AI-78) marks an account for Fable only.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- token files and a small state file, read synchronously at process start.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- token files and a small state file, read synchronously at process start.
import * as NodePath from "node:path";

const MAIN_CLAUDE_ACCOUNT = "main";
/** The Claude provider instance t4 clients run (settings.json `providerInstances.claudeAgent`). */
export const CLAUDE_INSTANCE_ID = "claudeAgent";
const UNKNOWN_RESET_MS = 60 * 60 * 1000;

export interface ClaudeAccount {
  /** The token file's name without extension, or "main" for the shared login. */
  readonly key: string;
  readonly token?: string;
}

interface AccountEntry {
  readonly key: string;
  /** The token file; none for the main login. */
  readonly file?: string;
}

/** Which used-up marks bind: every model's, or Fable's own weekly limit on top. */
export type ClaudeLimitScope = "all" | "fable";
/** Claude's rate-limit window for Fable's own weekly allowance. */
export const FABLE_RATE_LIMIT_TYPE = "seven_day_overage_included";
export const isFableModel = (model: string | null | undefined): boolean =>
  typeof model === "string" && /fable/i.test(model);

const keyOf = (file: string) => NodePath.basename(file).replace(/\.[^.]*$/, "");

let listCache: {
  file: string;
  mtimeMs: number | null;
  entries: ReadonlyArray<AccountEntry>;
} | null = null;

const listFromFile = (file: string): ReadonlyArray<AccountEntry> | null => {
  const mtimeMs = fileMtimeMs(file);
  if (mtimeMs === null) return null;
  if (listCache?.file === file && listCache.mtimeMs === mtimeMs) return listCache.entries;
  let entries: ReadonlyArray<AccountEntry> | null = null;
  try {
    const saved = JSON.parse(NodeFS.readFileSync(file, "utf8")) as { accounts?: unknown };
    if (Array.isArray(saved.accounts)) {
      entries = saved.accounts.flatMap((a): AccountEntry[] => {
        const entry = a as { key?: unknown; file?: unknown };
        if (typeof entry.key !== "string" || entry.key.length === 0) return [];
        if (entry.key === MAIN_CLAUDE_ACCOUNT) return [{ key: MAIN_CLAUDE_ACCOUNT }];
        return typeof entry.file === "string" ? [{ key: entry.key, file: entry.file }] : [];
      });
    }
  } catch {
    // Mid-write or unreadable: keep the last good list.
    return listCache?.file === file ? listCache.entries : null;
  }
  if (entries === null) return null;
  listCache = { file, mtimeMs, entries };
  return entries;
};

/** The accounts in the order new Claude processes try them, the main login once. */
const accountList = (env: NodeJS.ProcessEnv): ReadonlyArray<AccountEntry> => {
  const listFile = env.T4_CLAUDE_ACCOUNTS_FILE?.trim();
  const listed =
    (listFile ? listFromFile(listFile) : null) ??
    (env.T4_CLAUDE_ACCOUNTS ?? "")
      .split(",")
      .map((file) => file.trim())
      .filter((file) => file.length > 0)
      .map((file) => ({ key: keyOf(file), file }));
  const seen = new Set<string>();
  const entries = listed.filter((entry) => !seen.has(entry.key) && seen.add(entry.key));
  return seen.has(MAIN_CLAUDE_ACCOUNT) ? entries : [...entries, { key: MAIN_CLAUDE_ACCOUNT }];
};

/**
 * Whether the main login exists: Claude's own credentials in the config dir.
 * t4 keeps its own ~/.claude apart from the host's since 2026-11-07, with no
 * login copied (two copies of one rotating login log each other out), so
 * until one is made there, "main" is skipped like a used-up account.
 */
const mainLoginAvailable = (env: NodeJS.ProcessEnv): boolean => {
  const dir =
    env.CLAUDE_CONFIG_DIR?.trim() || (env.HOME ? NodePath.join(env.HOME, ".claude") : null);
  return dir === null || fileMtimeMs(NodePath.join(dir, ".credentials.json")) !== null;
};

const accountFiles = (env: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  accountList(env).flatMap((entry) => (entry.file === undefined ? [] : [entry.file]));

const statePath = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>) =>
  env.T4_CLAUDE_ACCOUNTS_STATE?.trim() ||
  NodePath.join(NodePath.dirname(env.T4_CLAUDE_ACCOUNTS_FILE?.trim() || files[0]!), "state.json");

interface LimitState {
  /** Used up for every model (the 5-hour and weekly limits). */
  readonly all: Map<string, number>;
  /** Used up for Fable only (its own weekly limit). */
  readonly fable: Map<string, number>;
}

let limitState: LimitState | null = null;
/** The state file's mtime when it was last read or written here. */
let loadedMtimeMs: number | null = null;

const fileMtimeMs = (file: string): number | null => {
  try {
    return NodeFS.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

const readMarks = (value: unknown): Map<string, number> => {
  const marks = new Map<string, number>();
  if (typeof value !== "object" || value === null) return marks;
  for (const [key, until] of Object.entries(value)) {
    if (typeof until === "number") marks.set(key, until);
  }
  return marks;
};

const loadState = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>): LimitState => {
  const file = statePath(env, files);
  const mtimeMs = fileMtimeMs(file);
  if (limitState !== null && (mtimeMs === null || mtimeMs === loadedMtimeMs)) return limitState;
  loadedMtimeMs = mtimeMs;
  try {
    const saved = JSON.parse(NodeFS.readFileSync(file, "utf8")) as Record<string, unknown>;
    limitState = {
      all: readMarks(saved.exhaustedUntil),
      fable: readMarks(saved.fableExhaustedUntil),
    };
  } catch {
    // No state yet, or unreadable: every account starts available.
    limitState = { all: new Map(), fable: new Map() };
  }
  return limitState;
};

const saveState = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>) => {
  try {
    const file = statePath(env, files);
    NodeFS.writeFileSync(
      `${file}.tmp`,
      JSON.stringify(
        {
          exhaustedUntil: Object.fromEntries(limitState?.all ?? []),
          fableExhaustedUntil: Object.fromEntries(limitState?.fable ?? []),
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    NodeFS.renameSync(`${file}.tmp`, file);
    loadedMtimeMs = fileMtimeMs(file);
  } catch {
    // Best effort: the in-memory state still steers this process.
  }
};

/** Until when `key` can't run `model`: its every-model mark, and Fable's own for a Fable model. */
const blockedUntil = (state: LimitState, key: string, model: string | null | undefined) =>
  Math.max(state.all.get(key) ?? 0, isFableModel(model) ? (state.fable.get(key) ?? 0) : 0);

const readToken = (file: string): string | undefined => {
  try {
    const token = NodeFS.readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

export const isClaudeAccountExhausted = (
  key: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  model?: string | null,
): boolean => {
  const files = accountFiles(env);
  if (files.length === 0) return false;
  // Taken off the list: its processes move to a listed account.
  if (!accountList(env).some((entry) => entry.key === key)) return true;
  if (key === MAIN_CLAUDE_ACCOUNT && !mainLoginAvailable(env)) return true;
  return blockedUntil(loadState(env, files), key, model) > nowMs;
};

/** The first account in order not used up for `model` (the main login included), else the main login. */
export const pickClaudeAccount = (
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  model?: string | null,
): ClaudeAccount => {
  const files = accountFiles(env);
  if (files.length === 0) return { key: MAIN_CLAUDE_ACCOUNT };
  const state = loadState(env, files);
  for (const { key, file } of accountList(env)) {
    if (blockedUntil(state, key, model) > nowMs) continue;
    if (file === undefined) {
      if (mainLoginAvailable(env)) return { key: MAIN_CLAUDE_ACCOUNT };
      continue;
    }
    const token = readToken(file);
    if (token !== undefined) return { key, token };
  }
  return { key: MAIN_CLAUDE_ACCOUNT };
};

export const claudeAccountEnvironment = (
  environment: NodeJS.ProcessEnv,
  account: ClaudeAccount,
): NodeJS.ProcessEnv =>
  account.token === undefined
    ? environment
    : { ...environment, CLAUDE_CODE_OAUTH_TOKEN: account.token };

/**
 * For Claude processes beside the sessions (status check, text generation): the account a new
 * session would get, else the first with a token, since a used-up account still signs in. Only a
 * client with no usable account at all is reported unauthenticated.
 */
export const claudeSideProcessEnvironment = (
  environment: NodeJS.ProcessEnv,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv => {
  const picked = pickClaudeAccount(nowMs, env);
  if (picked.token !== undefined || mainLoginAvailable(env))
    return claudeAccountEnvironment(environment, picked);
  for (const file of accountFiles(env)) {
    const token = readToken(file);
    if (token !== undefined)
      return claudeAccountEnvironment(environment, { key: keyOf(file), token });
  }
  return environment;
};

/**
 * Marks `key` used up until `resetAtMs` (an hour if unknown), for every model or, with scope
 * "fable", for Fable only. Returns when the thread can go on: now when another account is free
 * for it, else the earliest reset; undefined without t4 accounts.
 */
export const markClaudeAccountExhausted = (
  key: string,
  resetAtMs: number | null,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  scope: ClaudeLimitScope = "all",
): number | undefined => {
  const files = accountFiles(env);
  if (files.length === 0) return undefined;
  const state = loadState(env, files);
  state[scope].set(
    key,
    resetAtMs !== null && resetAtMs > nowMs ? resetAtMs : nowMs + UNKNOWN_RESET_MS,
  );
  saveState(env, files);
  const model = scope === "fable" ? "fable" : undefined;
  const keys = accountList(env)
    .map((entry) => entry.key)
    .filter((other) => other !== MAIN_CLAUDE_ACCOUNT || mainLoginAvailable(env));
  if (keys.length === 0) return nowMs + UNKNOWN_RESET_MS;
  const until = keys.map((other) => blockedUntil(state, other, model));
  if (until.some((at) => at <= nowMs)) return nowMs;
  return Math.min(...until);
};

/**
 * Whether a limit on `current` hands the thread to another account at once:
 * any other configured account (the main login included) not used up. The
 * limit notice then says so instead of "paused until the limit resets in
 * 2h 46m" for a thread that goes on within a minute (2026-10-30).
 */
export const anotherClaudeAccountFree = (
  current: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  model?: string | null,
): boolean => {
  const files = accountFiles(env);
  if (files.length === 0) return false;
  const state = loadState(env, files);
  return accountList(env).some(
    ({ key }) =>
      key !== current &&
      (key !== MAIN_CLAUDE_ACCOUNT || mainLoginAvailable(env)) &&
      blockedUntil(state, key, model) <= nowMs,
  );
};

/**
 * Whether every configured account (the main login when it exists) is used up
 * for `model`; false without t4 accounts. Wakes wait then instead of starting a
 * refused turn (ai-escape's 3-hourly AI-40 wake hit the weekly limit 10 times,
 * 2026-11-09).
 */
export const everyClaudeAccountUsedUp = (
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
  model?: string | null,
): boolean => {
  const files = accountFiles(env);
  if (files.length === 0) return false;
  const state = loadState(env, files);
  return accountList(env).every(
    ({ key }) =>
      (key === MAIN_CLAUDE_ACCOUNT && !mainLoginAvailable(env)) ||
      blockedUntil(state, key, model) > nowMs,
  );
};

/** Test hook: forget the loaded state. */
export const resetClaudeAccountState = () => {
  limitState = null;
  loadedMtimeMs = null;
  listCache = null;
};
