import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { toArchive } from "./T4AutoArchive.ts";

const HOUR = 3600_000;
const NOW = 100 * 24 * HOUR;

const thread = (id: string, over: Record<string, unknown> = {}) =>
  ({
    id,
    title: id,
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    settledAt: null,
    updatedAt: DateTime.makeUnsafe(NOW - 72 * HOUR),
    status: "completed",
    activeRunId: null,
    pendingRuntimeRequest: null,
    pendingBackgroundTasks: [],
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    ...over,
  }) as never;

const settledAgo = (hours: number) => ({ settledAt: DateTime.makeUnsafe(NOW - hours * HOUR) });

describe("t4 auto-archive", () => {
  it("archives threads settled two days ago, and their subagent helpers", () => {
    const threads = [
      thread("old", settledAgo(60)),
      thread("recent", settledAgo(10)),
      thread("unarchived-in-t3", { ...settledAgo(60), updatedAt: DateTime.makeUnsafe(NOW - HOUR) }),
      thread("open"),
      thread("rm", settledAgo(60)),
      thread("busy", { ...settledAgo(60), pendingBackgroundTasks: [{ taskId: "t" }] }),
      thread("helper-of-old", {
        lineage: { parentThreadId: "old", relationshipToParent: "subagent", rootThreadId: "old" },
      }),
      thread("helper-of-open", {
        lineage: { parentThreadId: "open", relationshipToParent: "subagent", rootThreadId: "open" },
      }),
      thread("helper-of-gone", {
        lineage: { parentThreadId: "gone", relationshipToParent: "subagent", rootThreadId: "gone" },
      }),
    ];
    const ids = toArchive(threads, (t) => (t as { id: string }).id === "rm", NOW, 48 * HOUR).map(
      (t) => (t as { id: string }).id,
    );
    expect(ids).toEqual(["old", "helper-of-old", "helper-of-gone"]);
  });
});
