// @effect-diagnostics nodeBuiltinImport:off - the test writes token files in a temp folder.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  claudeAccountEnvironment,
  claudeSideProcessEnvironment,
  everyClaudeAccountUsedUp,
  isClaudeAccountExhausted,
  markClaudeAccountExhausted,
  pickClaudeAccount,
  resetClaudeAccountState,
} from "./claudeAccounts.ts";

const setup = () => {
  const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-accounts-"));
  FS.writeFileSync(Path.join(dir, "1.token"), "token-one\n");
  FS.writeFileSync(Path.join(dir, "2.token"), "token-two\n");
  return {
    dir,
    env: { T4_CLAUDE_ACCOUNTS: `${dir}/1.token, ${dir}/2.token` } as NodeJS.ProcessEnv,
  };
};

afterEach(() => resetClaudeAccountState());

describe("t4 claudeAccounts", () => {
  it("uses the main login when no accounts are configured", () => {
    expect(pickClaudeAccount(0, {})).toEqual({ key: "main" });
    expect(markClaudeAccountExhausted("main", null, 0, {})).toBeUndefined();
    expect(claudeAccountEnvironment({ A: "1" }, { key: "main" })).toEqual({ A: "1" });
  });

  it("falls through the accounts in order, then to the main login", () => {
    const { env } = setup();
    expect(pickClaudeAccount(1_000, env)).toEqual({ key: "1", token: "token-one" });
    expect(claudeAccountEnvironment({ A: "1" }, pickClaudeAccount(1_000, env))).toEqual({
      A: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "token-one",
    });
    // Another account is free, so the thread goes on now.
    expect(markClaudeAccountExhausted("1", 50_000, 1_000, env)).toBe(1_000);
    expect(isClaudeAccountExhausted("1", 1_000, env)).toBe(true);
    expect(pickClaudeAccount(1_000, env).key).toBe("2");
    expect(markClaudeAccountExhausted("2", 90_000, 2_000, env)).toBe(2_000);
    expect(pickClaudeAccount(2_000, env)).toEqual({ key: "main" });
    expect(everyClaudeAccountUsedUp(2_000, env)).toBe(false);
    // All used up: go on when the first one resets.
    expect(markClaudeAccountExhausted("main", 70_000, 3_000, env)).toBe(50_000);
    expect(everyClaudeAccountUsedUp(3_000, env)).toBe(true);
    expect(everyClaudeAccountUsedUp(50_000, env)).toBe(false);
    expect(everyClaudeAccountUsedUp(3_000, {})).toBe(false);
    expect(pickClaudeAccount(50_000, env).key).toBe("1");
  });

  it("keeps what was used up across a restart, an hour when Claude gave no reset", () => {
    const { env, dir } = setup();
    markClaudeAccountExhausted("1", null, 1_000, env);
    resetClaudeAccountState();
    expect(isClaudeAccountExhausted("1", 1_000 + 60 * 60 * 1000 - 1, env)).toBe(true);
    expect(isClaudeAccountExhausted("1", 1_000 + 60 * 60 * 1000, env)).toBe(false);
    expect(FS.statSync(Path.join(dir, "state.json")).mode & 0o777).toBe(0o600);
  });

  it("sees a mark cleared in the state file by someone else (the dashboard)", () => {
    const { env, dir } = setup();
    markClaudeAccountExhausted("1", 50_000, 1_000, env);
    markClaudeAccountExhausted("2", 50_000, 1_000, env);
    markClaudeAccountExhausted("main", 900_000, 1_000, env);
    expect(markClaudeAccountExhausted("2", 50_000, 1_000, env)).toBe(50_000);
    const file = Path.join(dir, "state.json");
    FS.writeFileSync(file, JSON.stringify({ exhaustedUntil: { "1": 50_000, "2": 50_000 } }));
    const later = FS.statSync(file).mtimeMs / 1000 + 5;
    FS.utimesSync(file, later, later);
    expect(isClaudeAccountExhausted("main", 2_000, env)).toBe(false);
    expect(pickClaudeAccount(2_000, env)).toEqual({ key: "main" });
    expect(isClaudeAccountExhausted("1", 2_000, env)).toBe(true);
  });

  it("takes the order from the dashboard's list file, the main login anywhere in it", () => {
    const { dir } = setup();
    FS.writeFileSync(Path.join(dir, "fallback.token"), "token-fallback\n");
    const list = Path.join(dir, "accounts.json");
    const write = (keys: ReadonlyArray<string>, bump: number) => {
      const files: Record<string, string> = {
        "1": `${dir}/1.token`,
        "2": `${dir}/2.token`,
        fallback: `${dir}/fallback.token`,
      };
      FS.writeFileSync(
        list,
        JSON.stringify({
          accounts: keys.map((key) => (key === "main" ? { key } : { key, file: files[key] })),
        }),
      );
      const at = FS.statSync(list).mtimeMs / 1000 + bump;
      FS.utimesSync(list, at, at);
    };
    // The env list is ignored once the file exists.
    const env = {
      T4_CLAUDE_ACCOUNTS: `${dir}/2.token`,
      T4_CLAUDE_ACCOUNTS_FILE: list,
    } as NodeJS.ProcessEnv;
    write(["1", "main", "fallback"], 0);
    expect(pickClaudeAccount(1_000, env)).toEqual({ key: "1", token: "token-one" });
    expect(markClaudeAccountExhausted("1", 50_000, 1_000, env)).toBe(1_000);
    expect(pickClaudeAccount(1_000, env)).toEqual({ key: "main" });
    markClaudeAccountExhausted("main", 60_000, 1_000, env);
    expect(pickClaudeAccount(1_000, env)).toEqual({ key: "fallback", token: "token-fallback" });
    expect(FS.existsSync(Path.join(dir, "state.json"))).toBe(true);
    // Reordered live; an account taken off the list counts as used up.
    write(["fallback", "2"], 5);
    expect(pickClaudeAccount(1_000, env)).toEqual({ key: "fallback", token: "token-fallback" });
    expect(isClaudeAccountExhausted("1", 100_000, env)).toBe(true);
    expect(isClaudeAccountExhausted("2", 1_000, env)).toBe(false);
  });

  it("skips the main login when its config dir has no credentials", () => {
    const { dir, env } = setup();
    const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-home-"));
    FS.mkdirSync(Path.join(home, ".claude"));
    const list = Path.join(dir, "accounts.json");
    FS.writeFileSync(
      list,
      JSON.stringify({ accounts: [{ key: "main" }, { key: "2", file: `${dir}/2.token` }] }),
    );
    const noLogin = { ...env, HOME: home, T4_CLAUDE_ACCOUNTS_FILE: list } as NodeJS.ProcessEnv;
    expect(pickClaudeAccount(1_000, noLogin)).toEqual({ key: "2", token: "token-two" });
    expect(isClaudeAccountExhausted("main", 1_000, noLogin)).toBe(true);
    FS.writeFileSync(Path.join(home, ".claude", ".credentials.json"), "{}");
    expect(pickClaudeAccount(1_000, noLogin)).toEqual({ key: "main" });
  });

  it("signs the status check and text generation in with an account, used up or not", () => {
    const { dir, env } = setup();
    const home = FS.mkdtempSync(Path.join(OS.tmpdir(), "t4-home-"));
    const noLogin = { ...env, HOME: home } as NodeJS.ProcessEnv;
    expect(claudeSideProcessEnvironment({ A: "1" }, 1_000, noLogin)).toEqual({
      A: "1",
      CLAUDE_CODE_OAUTH_TOKEN: "token-one",
    });
    markClaudeAccountExhausted("1", 90_000, 1_000, noLogin);
    expect(claudeSideProcessEnvironment({}, 1_000, noLogin).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "token-two",
    );
    // Every account used up and no main login: a used-up account still signs in.
    markClaudeAccountExhausted("2", 90_000, 1_000, noLogin);
    expect(claudeSideProcessEnvironment({}, 1_000, noLogin).CLAUDE_CODE_OAUTH_TOKEN).toBe(
      "token-one",
    );
    // No usable account at all: left as it is, so T3 reports it unauthenticated.
    FS.rmSync(Path.join(dir, "1.token"));
    FS.rmSync(Path.join(dir, "2.token"));
    expect(claudeSideProcessEnvironment({ A: "1" }, 1_000, noLogin)).toEqual({ A: "1" });
    // Without t4 accounts nothing changes.
    expect(claudeSideProcessEnvironment({ A: "1" }, 1_000, { HOME: home })).toEqual({ A: "1" });
  });

  it("skips an account whose token file is missing", () => {
    const { env, dir } = setup();
    FS.rmSync(Path.join(dir, "1.token"));
    expect(pickClaudeAccount(0, env)).toEqual({ key: "2", token: "token-two" });
  });
});
