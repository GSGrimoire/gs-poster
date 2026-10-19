/**
 * Time helpers. Facebook wants UTC; Gus thinks in Copenhagen time.
 * No libraries: Intl does the timezone maths.
 */

function partsIn(date: Date, tz: string): Record<string, number> {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const out: Record<string, number> = {};
  for (const p of dtf.formatToParts(date)) {
    if (p.type !== "literal") out[p.type] = Number(p.value);
  }
  return out;
}

/** Offset of `tz` from UTC at `date`, in milliseconds (Copenhagen summer: +2h). */
export function tzOffsetMs(date: Date, tz: string): number {
  const p = partsIn(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  const whole = Math.floor(date.getTime() / 1000) * 1000;
  return asUtc - whole;
}

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/;

/** "2026-10-16T19:00" read as wall-clock time in `tz` → UTC Date. */
export function localToUtc(local: string, tz: string): Date {
  const m = NAIVE.exec(local.trim());
  if (!m) throw new Error(`Not a local date-time: "${local}" (expected YYYY-MM-DDTHH:mm)`);
  const [, y, mo, d, h, mi, s] = m;
  const guess = Date.UTC(+y, +mo - 1, +d, +h, +mi, s ? +s : 0);
  const off1 = tzOffsetMs(new Date(guess), tz);
  let t = guess - off1;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off1) t = guess - off2; // crossed a DST change
  return new Date(t);
}

/**
 * Accepts ISO with offset/Z ("2026-10-16T19:00:00+02:00") or a naive
 * local time, which is read in `tz`.
 */
export function parseWhen(input: string, tz: string): Date {
  const s = input.trim();
  if (NAIVE.test(s)) return localToUtc(s, tz);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`Could not read the time "${input}". Use e.g. 2026-10-16T19:00 (Copenhagen time) or full ISO 8601.`);
  return new Date(t);
}

/** UTC Date → "YYYY-MM-DDTHH:mm" in `tz`, for <input type="datetime-local">. */
export function toLocalInput(date: Date, tz: string): string {
  const p = partsIn(date, tz);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Day heading: "Thu 16 Oct". */
export function dayLabel(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", day: "numeric", month: "short" }).format(date);
}

/** Human form: "Thu 16 Oct, 19:00". */
export function formatLocal(date: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
}
