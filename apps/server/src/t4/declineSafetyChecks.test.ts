import { assert, describe, it } from "@effect/vitest";

import { safetyCheckDeclinedNote } from "./declineSafetyChecks.ts";

describe("safetyCheckDeclinedNote", () => {
  it("tells how to write a removal for rm commands, and to run a saved file otherwise", () => {
    for (const command of [undefined, "rm -rf /tmp/x", "cd web && rm -f ../a/*", "ls; rmdir out"]) {
      const note = safetyCheckDeclinedNote("Dangerous rm", command);
      assert.include(note, "one rm per target");
      assert.notInclude(note, "Write tool");
    }
    for (const command of [
      "python3 - <<'EOF'\nprint('confirm')\nEOF",
      "bash -c 'npm run format'",
    ]) {
      const note = safetyCheckDeclinedNote("This shell -c script could not be checked", command);
      assert.include(note, "save it with the Write tool to a file");
      assert.notInclude(note, "one rm per target");
    }
  });

  it("fits the advice to Claude Code 2.1.330's newer checks (AI-124)", () => {
    const cp = safetyCheckDeclinedNote(
      "Dangerous cp operation detected: '/srv/Code/x/*'",
      "cp -r build/* /srv/Code/x/",
    );
    assert.include(cp, "one `cp` per target");
    assert.notInclude(cp, "one rm per target");
    assert.include(safetyCheckDeclinedNote("", "mv a b && ls"), "For a copy or move");

    const workspace = safetyCheckDeclinedNote(
      "Dangerous rm operation detected: '/t3/worktrees/usa-1'\n\nThis command would remove a workspace directory (the working directory, an additional working directory, or one of their parent directories).",
      "rm -rf /t3/worktrees/usa-1",
    );
    assert.include(workspace, "your working directory or a folder above it");

    const critical = safetyCheckDeclinedNote(
      "Dangerous rm operation detected: '/home/max'\n\nThis command would remove a critical system directory.",
      "rm -rf ~",
    );
    assert.include(critical, "top-level folder");

    const variable = safetyCheckDeclinedNote(
      "Dangerous rm operation detected on possibly-empty variable path: $OUT/* (Use a literal absolute path instead.)",
      "rm -rf $OUT/*",
    );
    assert.include(variable, "could not tell where the path points");

    const unparsed = safetyCheckDeclinedNote(
      "Claude Code can't be sure it read this command the way the shell will, so it can't rule out a dangerous removal.",
      "cat > x.mjs <<'EOF'\nconsole.log(1)\nEOF",
    );
    assert.include(unparsed, "resend it in plain syntax");
    assert.include(unparsed, "Write tool");
  });
});
