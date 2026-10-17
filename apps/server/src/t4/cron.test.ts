import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import { nextScheduledRunAt } from "../scheduledTasks/Schedule.ts";
import { nextCronRunAt, parseCron } from "./cron.ts";
import { wakePrompt, wakeRefusal } from "./wakes.ts";

const utc = (iso: string) => DateTime.makeUnsafe(iso);
const iso = (value: DateTime.DateTime | null) =>
  value === null ? null : DateTime.formatIso(DateTime.toUtc(value));

describe("t4 cron", () => {
  it("finds the next weekday 09:00", () => {
    // 2026-10-17 is a Saturday.
    assert.equal(
      iso(nextCronRunAt("0 9 * * 1-5", utc("2026-10-17T10:00:00.000Z"))),
      "2026-10-19T09:00:00.000Z",
    );
  });
  it("handles steps, lists and the minute after `from`", () => {
    assert.equal(
      iso(nextCronRunAt("*/15 * * * *", utc("2026-10-17T10:07:30.000Z"))),
      "2026-10-17T10:15:00.000Z",
    );
    assert.equal(
      iso(nextCronRunAt("0 9,17 * * *", utc("2026-10-17T09:00:00.000Z"))),
      "2026-10-17T17:00:00.000Z",
    );
  });
  it("ORs day-of-month and day-of-week when both are restricted", () => {
    // The 1st of the month or any Monday: Mon 2026-10-19 comes before Nov 1.
    assert.equal(
      iso(nextCronRunAt("0 8 1 * 1", utc("2026-10-17T00:00:00.000Z"))),
      "2026-10-19T08:00:00.000Z",
    );
  });
  it("rejects malformed expressions", () => {
    assert.isNull(parseCron("0 9 * *"));
    assert.isNull(parseCron("61 * * * *"));
    assert.isNull(nextCronRunAt("x * * * *", utc("2026-10-17T00:00:00.000Z")));
  });
});

describe("t4 once schedule", () => {
  it("runs once in the future and never again", () => {
    const schedule = { type: "once" as const, at: "2026-10-17T12:00:00.000Z" };
    assert.equal(
      iso(nextScheduledRunAt(schedule, utc("2026-10-17T10:00:00.000Z"))),
      "2026-10-17T12:00:00.000Z",
    );
    assert.isNull(nextScheduledRunAt(schedule, utc("2026-10-17T12:00:00.000Z")));
  });
});

describe("t4 wake rules", () => {
  const now = Date.parse("2026-10-17T00:00:00.000Z");
  it("caps pending wakes, one-shot distance and recurring frequency", () => {
    assert.isUndefined(wakeRefusal({ type: "once", delayMs: 7_200_000 }, 0, now));
    assert.match(
      wakeRefusal({ type: "once", delayMs: 7_200_000 }, 8, now) ?? "",
      /8 pending wakes/,
    );
    assert.match(wakeRefusal({ type: "once", delayMs: 31 * 86_400_000 }, 0, now) ?? "", /30 days/);
    assert.match(wakeRefusal({ type: "interval", everyMs: 60_000 }, 0, now) ?? "", /5 minutes/);
    assert.isUndefined(wakeRefusal({ type: "cron", expression: "0 9 * * *" }, 0, now));
  });
  it("writes the WAKE header and the recurring reminder", () => {
    const once = wakePrompt({
      note: "check CI",
      scheduledAtLabel: "2026-10-17 00:00 UTC",
      byTitle: "USA-1 x",
      recurring: false,
    });
    assert.equal(once, 'WAKE (scheduled 2026-10-17 00:00 UTC by "USA-1 x"):\n\ncheck CI');
    assert.include(
      wakePrompt({ note: "n", scheduledAtLabel: "t", byTitle: undefined, recurring: true }),
      "Recurring",
    );
  });
});
