// @effect-diagnostics nodeBuiltinImport:off - the test writes token files in a temp folder.
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  claudeAccountEnvironment,
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
    // All used up: go on when the first one resets.
    expect(markClaudeAccountExhausted("main", 70_000, 3_000, env)).toBe(50_000);
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

  it("skips an account whose token file is missing", () => {
    const { env, dir } = setup();
    FS.rmSync(Path.join(dir, "1.token"));
    expect(pickClaudeAccount(0, env)).toEqual({ key: "2", token: "token-two" });
  });
});
