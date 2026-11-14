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
});
