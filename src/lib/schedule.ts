/**
 * When the digest is due. One frequent cron drives everything: each run sends
 * the digest if a digest time has passed since the last one went out, and
 * otherwise does a slice of work. Working from "has a slot passed" rather than
 * "is it the slot now" means a missed or failed run is caught up by the next.
 *
 * Digest times are wall-clock times in TIMEZONE, so they stay put across
 * daylight-saving changes (cron itself only knows UTC).
 */

import { localClock, type LocalParts } from "./time.ts";

const DAY = 86_400_000;

export interface DigestSchedule {
  days: readonly number[];
  hour: number;
  timezone: string;
}

/** Changes whenever the schedule settings do, so a stored next-digest time can be recomputed. */
export function scheduleKey(s: DigestSchedule): string {
  return `${s.days.join(",")}@${s.hour} ${s.timezone}`;
}

/**
 * The UTC instant of a local wall-clock time. When clocks go back and the time
 * happens twice, the first; when clocks go forward and it doesn't happen at
 * all, the moment just after the gap.
 */
function zonedTime(clock: (t: number) => LocalParts, y: number, m: number, d: number, hour: number): number {
  const target = Date.UTC(y, m - 1, d, hour);
  const offsetAt = (t: number) => {
    const p = clock(t);
    return Date.UTC(p.y, p.m - 1, p.d, p.h, p.min) - t;
  };
  // A DST change shifts the offset by at most a few hours: the offsets half a
  // day either side cover both readings of the time.
  const candidates = [target - offsetAt(target - DAY / 2), target - offsetAt(target + DAY / 2)].sort((a, b) => a - b);
  const exact = candidates.filter((t) => offsetAt(t) + t === target);
  return exact[0] ?? candidates[1]!;
}

/** Digest times on the local dates around `from`, stepping `dir` (-1 back, +1 forward) by half-days. */
function* slotsFrom(from: number, s: DigestSchedule, dir: 1 | -1): Generator<number> {
  const clock = localClock(s.timezone);
  const seen = new Set<string>();
  // Half-day steps: a 23- or 25-hour day can't make a whole-day step skip a date.
  for (let i = 0; i <= 17; i++) {
    const p = clock(from + (dir * i * DAY) / 2);
    const key = `${p.y}-${p.m}-${p.d}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (s.days.includes(new Date(Date.UTC(p.y, p.m - 1, p.d)).getUTCDay())) yield zonedTime(clock, p.y, p.m, p.d, s.hour);
  }
}

/** The most recent digest time at or before `now`, or null if none in the past 8 days. */
export function latestSlot(now: number, s: DigestSchedule): number | null {
  for (const slot of slotsFrom(now, s, -1)) if (slot <= now) return slot;
  return null;
}

/** The first digest time strictly after `after`, or null if none in the next 8 days. */
export function nextSlot(after: number, s: DigestSchedule): number | null {
  for (const slot of slotsFrom(after, s, 1)) if (slot > after) return slot;
  return null;
}

/** True when a digest time has passed since the last digest went out. */
export function digestDue(now: number, lastDigestAt: number, s: DigestSchedule): boolean {
  const next = nextSlot(lastDigestAt, s);
  return next !== null && next <= now;
}
