import { RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { limitRecoveryCommands } from "../orchestration-v2/UsageLimitRecoveryWorker.ts";
import type { ProjectionLimitRecoveryCandidate } from "../orchestration-v2/ProjectionStore.ts";
import { nextResumeSlotAt, resetResumePace, takeResumeSlot } from "./limitResumePace.ts";

const MIN = 60_000;
const RESET = Date.parse("2026-11-09T12:00:00.000Z");

/** A thread a limit stopped at `stoppedAt`, armed to resume at `resetAt`. */
const stopped = (name: string, stoppedAt: number, resetAt = RESET) => {
  const runId = RunId.make(`run:${name}`);
  const resetIso = DateTime.formatIso(DateTime.makeUnsafe(resetAt));
  return {
    id: ThreadId.make(`thread:${name}`),
    status: "failed",
    lastErrorClass: "usage_limit",
    latestRunId: runId,
    usageLimitResetAt: resetIso,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    latestRunCompletedAt: DateTime.makeUnsafe(stoppedAt),
    updatedAt: DateTime.makeUnsafe(stoppedAt),
    limitRecovery: { runId, resetAt: resetIso, autoResume: true },
    snoozedUntil: null,
  } as ProjectionLimitRecoveryCandidate;
};

const resumed = ({ commands }: ReturnType<typeof limitRecoveryCommands>) =>
  commands
    .filter(({ command }) => command.type === "message.dispatch")
    .map(({ thread }) => thread.id);

afterEach(() => resetResumePace());

describe("t4 limit resume pace", () => {
  it("resumes three threads per five minutes at a reset, oldest stop first", () => {
    const threads = ["e", "b", "a", "d", "c"].map((name) =>
      stopped(name, RESET - 3 * 3_600_000 + name.charCodeAt(0) * MIN),
    );
    expect(resumed(limitRecoveryCommands(threads, true, RESET))).toEqual([
      "thread:a",
      "thread:b",
      "thread:c",
    ]);
    // The next sweeps find the rest still due and wait for the pace.
    const rest = threads.filter((t) => ["thread:d", "thread:e"].includes(t.id));
    expect(limitRecoveryCommands(rest, true, RESET + 4 * MIN).paced).toBe(2);
    expect(resumed(limitRecoveryCommands(rest, true, RESET + 4 * MIN))).toEqual([]);
    expect(resumed(limitRecoveryCommands(rest, true, RESET + 5 * MIN))).toEqual([
      "thread:d",
      "thread:e",
    ]);
  });

  it("hands a thread to another free account at once, outside the pace", () => {
    for (const _ of [1, 2, 3]) takeResumeSlot(RESET);
    const handOff = stopped("hand-off", RESET - 30_000, RESET + 30_000);
    expect(resumed(limitRecoveryCommands([handOff], true, RESET + 30_000))).toEqual([
      "thread:hand-off",
    ]);
  });

  it("frees a slot when the oldest of the last batch is a gap old", () => {
    const pace = { batch: 3, gapMs: 5 * MIN };
    expect(nextResumeSlotAt(0, pace)).toBe(0);
    for (const at of [0, MIN, 2 * MIN]) expect(takeResumeSlot(at, pace)).toBe(true);
    expect(takeResumeSlot(3 * MIN, pace)).toBe(false);
    expect(nextResumeSlotAt(3 * MIN, pace)).toBe(5 * MIN);
    expect(takeResumeSlot(5 * MIN, pace)).toBe(true);
    expect(nextResumeSlotAt(5 * MIN, pace)).toBe(6 * MIN);
  });
});
