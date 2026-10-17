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

/** The first matching minute after `from`, within a year; null if none or invalid. */
export function nextCronRunAt(
  expression: string,
  from: DateTime.DateTime,
): DateTime.DateTime | null {
  const cron = parseCron(expression);
  if (cron === null) return null;
  let t = DateTime.add(DateTime.setParts(from, { second: 0, millisecond: 0 }), { minutes: 1 });
  for (let i = 0; i < 366 * 24 * 60; i++) {
    const p = DateTime.toParts(t);
    if (!cron.months.has(p.month)) {
      t = DateTime.add(DateTime.setParts(t, { day: 1, hour: 0, minute: 0 }), { months: 1 });
      continue;
    }
    const dayOk =
      cron.dayAny || cron.weekdayAny
        ? cron.days.has(p.day) && cron.weekdays.has(p.weekDay)
        : cron.days.has(p.day) || cron.weekdays.has(p.weekDay);
    if (!dayOk) {
      t = DateTime.add(DateTime.setParts(t, { hour: 0, minute: 0 }), { days: 1 });
      continue;
    }
    if (!cron.hours.has(p.hour)) {
      t = DateTime.add(DateTime.setParts(t, { minute: 0 }), { hours: 1 });
      continue;
    }
    if (cron.minutes.has(p.minute)) return t;
    t = DateTime.add(t, { minutes: 1 });
  }
  return null;
}
