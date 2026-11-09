import { assert, describe, it } from "@effect/vitest";

import { roleOf } from "./T4Facts.ts";

describe("roleOf", () => {
  const thread = (title: string) => ({ id: "t1", title });
  it("puts the release manager first, then a given role, then the title", () => {
    assert.equal(roleOf(thread("AI-1 PM"), true, new Map([["t1", "owner"]])), "release-manager");
    assert.equal(roleOf(thread("AI-1 PM"), false, new Map([["t1", "owner"]])), "owner");
    assert.equal(roleOf(thread("AI-1 checkout"), false, new Map([["t1", "pm"]])), "pm");
    assert.equal(roleOf(thread("AI-27 PM chatbot"), false, new Map()), "pm");
    assert.equal(roleOf(thread("AI-2 PMI export"), false, new Map()), "owner");
  });
});
