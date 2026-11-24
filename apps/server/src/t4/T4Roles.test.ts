import { assert, describe, it } from "@effect/vitest";

import { roleOf } from "./T4Facts.ts";
import { inQuietHours, mergeItems, triggerMessage } from "./T4Roles.ts";
import {
  claudeAutoCompactWindowFor,
  compactAtTokensFor,
  setThreadCompaction,
} from "./threadCompaction.ts";

const empty = {
  state: "",
  since: null,
  lastRunAt: null,
  lastOk: null,
  lastError: null,
  failures: 0,
  lastFailNoteAt: null,
  lastFiredAt: null,
  seen: [],
  pending: [],
  pendingSince: null,
};
const item = (id: string) => ({ id, title: `issue ${id}`, url: `https://x/${id}` });
const now = Date.parse("2026-11-23T20:00:00.000Z");

describe("t4 roles", () => {
  it("records a trigger's first run as a baseline without pending items", () => {
    const { next, added } = mergeItems(empty, [item("a"), item("b")], now);
    assert.equal(added, 0);
    assert.deepEqual(next.seen, ["a", "b"]);
    assert.equal(next.pending.length, 0);
  });

  it("queues only items it has not seen, from the second run on", () => {
    const second = { ...empty, lastOk: true, since: "2026-11-23T19:55:00.000Z", seen: ["a"] };
    const { next, added } = mergeItems(second, [item("a"), item("c")], now);
    assert.equal(added, 1);
    assert.deepEqual(
      next.pending.map((p) => p.id),
      ["c"],
    );
    assert.equal(next.pendingSince, "2026-11-23T20:00:00.000Z");
    const again = mergeItems(next, [item("c")], now + 60_000);
    assert.equal(again.added, 0);
    // The batch window keeps counting from the first pending item.
    assert.equal(again.next.pendingSince, "2026-11-23T20:00:00.000Z");
  });

  it("writes one message for several triggers, capped per trigger", () => {
    const many = Array.from({ length: 33 }, (_, i) => item(String(i)));
    const text = triggerMessage(
      [
        { label: "New Sentry issues", items: [item("x")] },
        { label: "Red main", items: many },
      ],
      { id: "role-1", title: "Sentry watch - usa-rs" },
    );
    assert.include(text, "**New Sentry issues**: 1 new");
    assert.include(text, "- [issue x](https://x/x)");
    assert.include(text, "**Red main**: 33 new");
    assert.include(text, "- and 3 more");
    assert.include(text, "end your turn in one line");
    assert.include(text, "~/.config/t4/roles/role-1.md");
  });

  it("knows quiet hours in Pacific time, across midnight", () => {
    const quiet = { start: "22:00", end: "07:00" };
    // 2026-11-24T06:30Z is 22:30 PST on the 23rd; 15:00Z is 07:00 PST.
    assert.isTrue(inQuietHours(quiet, Date.parse("2026-11-24T06:30:00.000Z")));
    assert.isTrue(inQuietHours(quiet, Date.parse("2026-11-24T14:59:00.000Z")));
    assert.isFalse(inQuietHours(quiet, Date.parse("2026-11-24T15:00:00.000Z")));
    assert.isFalse(inQuietHours(null, Date.parse("2026-11-24T06:30:00.000Z")));
    assert.isTrue(
      inQuietHours({ start: "12:00", end: "13:00" }, Date.parse("2026-11-23T20:30:00.000Z")),
    );
  });

  it("gives a standing role thread the role role", () => {
    assert.equal(roleOf({ id: "t", title: "Sentry watch PM" }, false, new Map(), true), "role");
    assert.equal(
      roleOf({ id: "t", title: "Release manager" }, true, new Map(), true),
      "release-manager",
    );
  });

  it("keeps a compaction point per thread", () => {
    setThreadCompaction(new Map([["t4-rm-1", 150_000]]));
    assert.equal(compactAtTokensFor("t4-rm-1"), 150_000);
    assert.equal(compactAtTokensFor("other"), undefined);
    assert.equal(compactAtTokensFor(null), undefined);
    assert.equal(claudeAutoCompactWindowFor(150_000), "183000");
    setThreadCompaction(new Map());
  });
});
