/**
 * t4 fork: 5-field cron (minute hour day-of-month month day-of-week) in the
 * time zone of `from`. Behaviour contract: `cron_next()` in t4's
 * `t3agents.py` - `*`, lists, ranges and steps; day-of-month and
 * day-of-week combine with OR when both are restricted (Vixie cron).
 */
import * as DateTime from "effect/DateTime";

function field(spec: string, lo: number, hi: number): ReadonlySet<number> | null {
  const values = new Set<number>();
  for (const part of spec.split(",")) {
    const [range = "", stepText] = part.split("/");
    const step = stepText === undefined ? 1 : Number(stepText);
    if (!Number.isInteger(step) || step < 1) return null;
    let a: number;
    let b: number;
    if (range === "*") [a, b] = [lo, hi];
    else if (range.includes("-")) [a, b] = range.split("-").map(Number) as [number, number];
    else a = b = Number(range);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < lo || b > hi || a > b) return null;
    for (let v = a; v <= b; v += step) values.add(v);
  }
  return values;
}

export interface ParsedCron {
  readonly minutes: ReadonlySet<number>;
  readonly hours: ReadonlySet<number>;
  readonly days: ReadonlySet<number>;
  readonly months: ReadonlySet<number>;
  readonly weekdays: ReadonlySet<number>;
  readonly dayAny: boolean;
  readonly weekdayAny: boolean;
}

export function parseCron(expression: string): ParsedCron | null {
  const f = expression.trim().split(/\s+/);
  if (f.length !== 5) return null;
  const minutes = field(f[0]!, 0, 59);
  const hours = field(f[1]!, 0, 23);
  const days = field(f[2]!, 1, 31);
  const months = field(f[3]!, 1, 12);
  const weekdaysRaw = field(f[4]!, 0, 7);
  if (!minutes || !hours || !days || !months || !weekdaysRaw) return null;
  return {
    minutes,
    hours,
    days,
    months,
    weekdays: new Set([...weekdaysRaw].map((d) => d % 7)),
    dayAny: f[2] === "*",
    weekdayAny: f[4] === "*",
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * The first matching minute after `from`, within a year; null if none or invalid.
 * Steps by elapsed time, never by setting wall-clock fields: those resolve a repeated
 * fall-back hour to its first pass and looped (2026-11-01). A repeated hour runs once.
 */
export function nextCronRunAt(
  expression: string,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  const start = DateTime.toEpochMillis(from);
  const limit = start + 366 * 24 * HOUR_MS;
  let t = DateTime.addDuration(from, MINUTE_MS - (((start % MINUTE_MS) + MINUTE_MS) % MINUTE_MS));
  while (DateTime.toEpochMillis(t) <= limit) {
    const p = DateTime.toParts(t);
    const dayOk =
      cron.dayAny || cron.weekdayAny
        ? cron.days.has(p.day) && cron.weekdays.has(p.weekDay)
        : cron.days.has(p.day) || cron.weekdays.has(p.weekDay);
    const before = DateTime.toParts(DateTime.addDuration(t, -HOUR_MS));
    const repeatedHour = before.day === p.day && before.hour === p.hour;
    if (!cron.months.has(p.month) || !dayOk || !cron.hours.has(p.hour) || repeatedHour) {
      // To the next hour boundary; zones here shift by whole hours, so this
      // visits every wall-clock hour.
      t = DateTime.addDuration(t, (60 - p.minute) * MINUTE_MS);
      continue;
    }
    if (cron.minutes.has(p.minute)) return t;
    t = DateTime.addDuration(t, MINUTE_MS);
  }
  return null;
}
