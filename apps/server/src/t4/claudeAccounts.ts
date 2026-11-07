/**
 * t4 fork: extra Claude accounts used before the main login.
 *
 * `T4_CLAUDE_ACCOUNTS` lists long-lived OAuth token files (`claude
 * setup-token`), in priority order. A new Claude process gets the first
 * account that has not hit its usage limit as `CLAUDE_CODE_OAUTH_TOKEN`; only
 * when every one has does it fall back to the main login (the shared
 * `~/.claude` credentials). Only the login changes: settings, skills and
 * transcripts stay in the one `~/.claude`, so a thread resumes on another
 * account with its whole history. A turn stopped by a limit marks its account
 * used up until the reset Claude reported, and is resumed at once when another
 * account is free (ClaudeAdapterV2 reports the reset as now). A live process
 * whose account is used up is replaced at the next turn; one on the main
 * login moves back to an account when it next starts (an idle session is
 * released). usa-rs, 2026-10-29: two Team seats ahead of the main login.
 *
 * The order can instead come from `T4_CLAUDE_ACCOUNTS_FILE`, a JSON list the
 * t4 dashboard writes (`{"accounts": [{"key", "file"?}]}`; `main` is the
 * shared login and can sit anywhere, e.g. before a fallback account every
 * client shares). It is re-read when it changes, so accounts are added,
 * signed in again, reordered or removed without restarting the container; an
 * account taken off the list counts as used up, so its live processes move
 * on at their next turn. Without the file, `T4_CLAUDE_ACCOUNTS` applies.
 *
 * Which account was used up until when is kept beside the tokens
 * (`state.json`), so a restart does not retry an exhausted one. The file is
 * re-read when it changes: the dashboard clears a mark the account's live
 * limits contradict. On 2026-11-01 the main login sat marked used up until its
 * weekly reset, three days out, with 9% of its week used (it had just moved
 * to a plan with no 5-hour limit); once both seats ran out, five threads
 * waited hours for a seat's reset.
 */
// @effect-diagnostics-next-line nodeBuiltinImport:off -- token files and a small state file, read synchronously at process start.
import * as FS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- token files and a small state file, read synchronously at process start.
import * as Path from "node:path";

export const MAIN_CLAUDE_ACCOUNT = "main";
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

const keyOf = (file: string) => Path.basename(file).replace(/\.[^.]*$/, "");

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
    const saved = JSON.parse(FS.readFileSync(file, "utf8")) as { accounts?: unknown };
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

const accountFiles = (env: NodeJS.ProcessEnv): ReadonlyArray<string> =>
  accountList(env).flatMap((entry) => (entry.file === undefined ? [] : [entry.file]));

const statePath = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>) =>
  env.T4_CLAUDE_ACCOUNTS_STATE?.trim() ||
  Path.join(Path.dirname(env.T4_CLAUDE_ACCOUNTS_FILE?.trim() || files[0]!), "state.json");

let exhaustedUntil: Map<string, number> | null = null;
/** The state file's mtime when it was last read or written here. */
let loadedMtimeMs: number | null = null;

const fileMtimeMs = (file: string): number | null => {
  try {
    return FS.statSync(file).mtimeMs;
  } catch {
    return null;
  }
};

const loadState = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>) => {
  const file = statePath(env, files);
  const mtimeMs = fileMtimeMs(file);
  if (exhaustedUntil !== null && (mtimeMs === null || mtimeMs === loadedMtimeMs))
    return exhaustedUntil;
  exhaustedUntil = new Map();
  loadedMtimeMs = mtimeMs;
  try {
    const saved = JSON.parse(FS.readFileSync(file, "utf8")) as Record<string, unknown>;
    for (const [key, until] of Object.entries(saved.exhaustedUntil ?? {})) {
      if (typeof until === "number") exhaustedUntil.set(key, until);
    }
  } catch {
    // No state yet, or unreadable: every account starts available.
  }
  return exhaustedUntil;
};

const saveState = (env: NodeJS.ProcessEnv, files: ReadonlyArray<string>) => {
  try {
    const file = statePath(env, files);
    FS.writeFileSync(
      `${file}.tmp`,
      JSON.stringify({ exhaustedUntil: Object.fromEntries(exhaustedUntil ?? []) }, null, 2),
      { mode: 0o600 },
    );
    FS.renameSync(`${file}.tmp`, file);
    loadedMtimeMs = fileMtimeMs(file);
  } catch {
    // Best effort: the in-memory state still steers this process.
  }
};

const readToken = (file: string): string | undefined => {
  try {
    const token = FS.readFileSync(file, "utf8").trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
};

export const t4ClaudeAccountsEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  accountFiles(env).length > 0;

export const isClaudeAccountExhausted = (
  key: string,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): boolean => {
  const files = accountFiles(env);
  if (files.length === 0) return false;
  // Taken off the list: its processes move to a listed account.
  if (!accountList(env).some((entry) => entry.key === key)) return true;
  return (loadState(env, files).get(key) ?? 0) > nowMs;
};

/** The first account in order not used up (the main login included), else the main login. */
export const pickClaudeAccount = (
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): ClaudeAccount => {
  const files = accountFiles(env);
  if (files.length === 0) return { key: MAIN_CLAUDE_ACCOUNT };
  const state = loadState(env, files);
  for (const { key, file } of accountList(env)) {
    if ((state.get(key) ?? 0) > nowMs) continue;
    if (file === undefined) return { key: MAIN_CLAUDE_ACCOUNT };
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
 * Records that `key` hit its usage limit until `resetAtMs` (an hour when
 * Claude gave no reset). Returns when the thread can go on: `nowMs` when
 * another account is free, else the earliest time any account frees up -
 * or undefined without t4 accounts configured.
 */
export const markClaudeAccountExhausted = (
  key: string,
  resetAtMs: number | null,
  nowMs: number,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined => {
  const files = accountFiles(env);
  if (files.length === 0) return undefined;
  const state = loadState(env, files);
  state.set(key, resetAtMs !== null && resetAtMs > nowMs ? resetAtMs : nowMs + UNKNOWN_RESET_MS);
  saveState(env, files);
  const keys = accountList(env).map((entry) => entry.key);
  if (keys.some((other) => (state.get(other) ?? 0) <= nowMs)) return nowMs;
  return Math.min(...keys.map((other) => state.get(other)!));
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
): boolean => {
  const files = accountFiles(env);
  if (files.length === 0) return false;
  const state = loadState(env, files);
  return accountList(env).some(({ key }) => key !== current && (state.get(key) ?? 0) <= nowMs);
};

/** Test hook: forget the loaded state. */
export const resetClaudeAccountState = () => {
  exhaustedUntil = null;
  loadedMtimeMs = null;
  listCache = null;
};
