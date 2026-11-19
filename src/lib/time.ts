/**
 * Dates without Intl where possible. The first Intl.DateTimeFormat in a fresh
 * isolate costs about 7 ms of CPU (it loads timezone and locale data), most of
 * the Workers Free 10 ms limit, while plain Date methods cost almost nothing.
 * So UTC, the default, is done by hand, and Intl is only built on first use.
 */

const UTC_NAMES = /^(utc|gmt|z|zulu|universal|etc\/(utc|gmt|zulu|universal|uct|gmt[+-]?0)|uct|gmt[+-]?0)$/i;

export function isUtc(timezone: string): boolean {
  return UTC_NAMES.test(timezone.trim());
}

export interface LocalParts {
  y: number;
  /** 1-12 */
  m: number;
  d: number;
  h: number;
  min: number;
}

/** Local calendar fields of an instant in `timezone`. Intl is created on first non-UTC use. */
export function localClock(timezone: string): (t: number) => LocalParts {
  if (isUtc(timezone)) {
    return (t) => {
      const x = new Date(t);
      return { y: x.getUTCFullYear(), m: x.getUTCMonth() + 1, d: x.getUTCDate(), h: x.getUTCHours(), min: x.getUTCMinutes() };
    };
  }
  let fmt: Intl.DateTimeFormat | undefined;
  return (t) => {
    fmt ??= new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    const p: Record<string, number> = {};
    for (const { type, value } of fmt.formatToParts(new Date(t))) if (type !== "literal") p[type] = Number(value);
    return { y: p.year!, m: p.month!, d: p.day!, h: p.hour! % 24, min: p.minute! };
  };
}

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mon, 23 Nov 2026" in `timezone` (the en-GB short form). */
export function dateFormatter(timezone: string): (d: Date | number) => string {
  if (isUtc(timezone)) {
    return (d) => {
      const x = typeof d === "number" ? new Date(d) : d;
      return `${WEEKDAY[x.getUTCDay()]}, ${x.getUTCDate()} ${MONTH[x.getUTCMonth()]} ${x.getUTCFullYear()}`;
    };
  }
  let f: Intl.DateTimeFormat | undefined;
  return (d) => {
    f ??= new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
    return f.format(typeof d === "number" ? new Date(d) : d);
  };
}

/** "2026-11-23" in `timezone`. */
export function isoDate(d: Date, timezone: string): string {
  if (isUtc(timezone)) return d.toISOString().slice(0, 10);
  const p = localClock(timezone)(d.getTime());
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}

/** "Fri 20 Nov, 14:05" in `timezone`. Intl only for non-UTC zones, on first use. */
export function timeFormatter(timezone: string): (t: number) => string {
  const clock = localClock(timezone);
  return (t) => {
    const p = clock(t);
    // Weekday from the local calendar date, which needs no Intl.
    const weekday = WEEKDAY[new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay()];
    return `${weekday} ${p.d} ${MONTH[p.m - 1]}, ${String(p.h).padStart(2, "0")}:${String(p.min).padStart(2, "0")}`;
  };
}
