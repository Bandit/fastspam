import { describe, expect, it } from "vitest";
import { digestDue, latestSlot, nextSlot } from "../src/lib/schedule.ts";
import { dateFormatter, isoDate, isUtc, localClock } from "../src/lib/time.ts";
import { digestDays } from "../src/config.ts";

const iso = (t: number | null) => (t === null ? null : new Date(t).toISOString());
const mondays8pm = { days: [1], hour: 20, timezone: "UTC" };

describe("digest schedule", () => {
  it("finds the most recent digest time", () => {
    // Monday 23 Nov 2026.
    expect(iso(latestSlot(Date.parse("2026-11-23T20:00:00Z"), mondays8pm))).toBe("2026-11-23T20:00:00.000Z");
    expect(iso(latestSlot(Date.parse("2026-11-23T19:59:00Z"), mondays8pm))).toBe("2026-11-16T20:00:00.000Z");
    expect(iso(latestSlot(Date.parse("2026-11-26T09:00:00Z"), mondays8pm))).toBe("2026-11-23T20:00:00.000Z");
    expect(iso(latestSlot(Date.parse("2026-11-26T09:00:00Z"), { days: [0, 1, 2, 3, 4, 5, 6], hour: 8, timezone: "UTC" }))).toBe("2026-11-26T08:00:00.000Z");
  });

  it("is due once a digest time has passed since the last digest, and catches up a missed run", () => {
    const last = Date.parse("2026-11-16T20:05:00Z");
    expect(digestDue(Date.parse("2026-11-23T19:45:00Z"), last, mondays8pm)).toBe(false);
    expect(digestDue(Date.parse("2026-11-23T20:00:00Z"), last, mondays8pm)).toBe(true);
    // Missed 20:00 and 20:15: still due at 20:30, and on Wednesday.
    expect(digestDue(Date.parse("2026-11-23T20:30:00Z"), last, mondays8pm)).toBe(true);
    expect(digestDue(Date.parse("2026-11-25T03:00:00Z"), last, mondays8pm)).toBe(true);
    // Sent at 20:00: not due again until next Monday.
    expect(digestDue(Date.parse("2026-11-23T20:15:00Z"), Date.parse("2026-11-23T20:00:00Z"), mondays8pm)).toBe(false);
  });

  it("keeps local time across daylight saving, which a UTC cron can't", () => {
    const london9 = { days: [1], hour: 9, timezone: "Europe/London" };
    expect(iso(latestSlot(Date.parse("2026-07-06T12:00:00Z"), london9))).toBe("2026-07-06T08:00:00.000Z"); // BST
    expect(iso(latestSlot(Date.parse("2026-11-23T12:00:00Z"), london9))).toBe("2026-11-23T09:00:00.000Z"); // GMT
    // Half-hour offsets.
    expect(iso(latestSlot(Date.parse("2026-11-23T12:00:00Z"), { days: [1], hour: 9, timezone: "Asia/Kolkata" }))).toBe("2026-11-23T03:30:00.000Z");
  });

  it("handles the hour that doesn't exist, and the one that happens twice", () => {
    // US clocks go forward at 02:00 on Sunday 8 Mar 2026: 02:00 doesn't exist, so 03:00 EDT.
    const gap = { days: [0], hour: 2, timezone: "America/New_York" };
    expect(iso(latestSlot(Date.parse("2026-03-08T12:00:00Z"), gap))).toBe("2026-03-08T07:00:00.000Z");
    // They go back at 02:00 on Sunday 1 Nov 2026: 01:00 happens twice; the first one counts.
    const twice = { days: [0], hour: 1, timezone: "America/New_York" };
    expect(iso(latestSlot(Date.parse("2026-11-01T12:00:00Z"), twice))).toBe("2026-11-01T05:00:00.000Z");
    // Just after midnight following the short day, that day's slot is still found.
    const sunday10pm = { days: [0], hour: 22, timezone: "America/New_York" };
    expect(iso(latestSlot(Date.parse("2026-03-09T04:30:00Z"), sunday10pm))).toBe("2026-03-09T02:00:00.000Z");
  });

  it("finds the next digest time", () => {
    expect(iso(nextSlot(Date.parse("2026-11-23T20:00:00Z"), mondays8pm))).toBe("2026-11-30T20:00:00.000Z");
    expect(iso(nextSlot(Date.parse("2026-11-23T19:59:59Z"), mondays8pm))).toBe("2026-11-23T20:00:00.000Z");
    expect(iso(nextSlot(Date.parse("2026-03-07T12:00:00Z"), { days: [0], hour: 2, timezone: "America/New_York" }))).toBe("2026-03-08T07:00:00.000Z");
  });

  it("parses DIGEST_DAYS", () => {
    expect(digestDays(undefined)).toEqual([1]);
    expect(digestDays("Mon, Thursday")).toEqual([1, 4]);
    expect(digestDays("daily")).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(digestDays("someday")).toEqual([1]);
  });
});

describe("dates without Intl", () => {
  const instants = ["2026-01-01T00:00:00Z", "2026-02-28T23:59:59Z", "2026-07-06T12:34:00Z", "2026-11-23T20:00:00Z", "2028-02-29T05:00:00Z"].map(Date.parse);
  it("formats UTC by hand exactly as Intl would", () => {
    const intl = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short", day: "numeric", month: "short", year: "numeric" });
    const mine = dateFormatter("UTC");
    for (const t of instants) {
      expect(mine(t)).toBe(intl.format(t));
      expect(isoDate(new Date(t), "UTC")).toBe(new Date(t).toISOString().slice(0, 10));
    }
    expect(isoDate(new Date("2026-11-23T20:00:00Z"), "Asia/Kolkata")).toBe("2026-11-24");
  });
  it("reads local fields the same way with and without Intl", () => {
    for (const t of instants) expect(localClock("UTC")(t)).toEqual(localClock("Europe/London")(t - (Date.parse("2026-07-01") < t && t < Date.parse("2026-10-25") ? 3_600_000 : 0)));
  });
  it("recognises UTC spellings", () => {
    expect(["UTC", "Etc/UTC", "GMT", "etc/gmt", "Etc/GMT+0", "Universal"].every(isUtc)).toBe(true);
    expect(["Europe/London", "America/New_York", ""].some(isUtc)).toBe(false);
  });
});
