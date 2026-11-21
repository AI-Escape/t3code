import { assert, describe, it } from "@effect/vitest";

import { redactKeys, redactKeyTitles } from "./redactTitles.ts";

describe("redactKeys", () => {
  it("drops key-shaped tokens from a title and keeps ordinary words, ids and hashes", () => {
    assert.equal(redactKeys("BSAq7Xk2mPz9Lr4Tn8Wv1Yc6Hd3Jf5"), "[key]");
    assert.equal(redactKeys("use sk-proj-abcdefghijklmnop1234 here"), "use [key] here");
    assert.equal(redactKeys("ghp_abcdefghijklmnopqrstuvwxyz0123"), "[key]");
    for (const title of [
      "USA-818 Fix malformed contact email",
      "Verify 9286781c4f1e2d3b4a5968778695a4b3c2d1e0f9 on staging",
      "Rename ClaudeAdapterV2 test helpers",
      "Thread 0d7a5c1e-6b8f-4e2a-9c3d-1f2e3a4b5c6d",
    ]) {
      assert.equal(redactKeys(title), title);
    }
  });

  it("redacts the title fields of a command and leaves the rest", () => {
    const command = {
      type: "thread.create",
      title: "BSAq7Xk2mPz9Lr4Tn8Wv1Yc6Hd3Jf5",
      text: "BSAq7Xk2mPz9Lr4Tn8Wv1Yc6Hd3Jf5",
    };
    assert.deepEqual(redactKeyTitles(command), { ...command, title: "[key]" });
    const clean = { type: "message.dispatch", titleSeed: "Fix the footer" };
    assert.strictEqual(redactKeyTitles(clean), clean);
  });
});
