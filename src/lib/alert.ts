import type { Message } from "../notify/notifier.ts";
import type { Failure } from "./state.ts";
import { clean } from "./sanitise.ts";
import { isUtc, timeFormatter } from "./time.ts";

/** "7003: User Input Error (3 times, last Fri 20 Nov, 03:30 UTC)" */
export function failureFormatter(timezone: string): (f: Failure) => string {
  const when = timeFormatter(timezone);
  const zone = isUtc(timezone) ? " UTC" : "";
  return (f) => {
    const time = f.last ? `${when(Date.parse(f.last))}${zone}` : "";
    const detail = f.count > 1 ? `${f.count} times${time ? `, last ${time}` : ""}` : time;
    return `${clean(f.message, 300)}${detail ? ` (${detail})` : ""}`;
  };
}

export interface AlertInput {
  failures: Failure[];
  runs: number;
  since: Date;
  timezone: string;
}

/**
 * Sent when work runs keep failing, so a lasting problem (a revoked token, a
 * model that keeps refusing a message) doesn't wait for the weekly digest.
 */
export function renderAlert(input: AlertInput): Message {
  const when = timeFormatter(input.timezone);
  const zone = isUtc(input.timezone) ? " UTC" : "";
  const line = failureFormatter(input.timezone);
  const lines = [
    `fastspam has hit a problem on ${input.runs} runs in a row, since ${when(input.since.getTime())}${zone}.`,
    "",
    ...input.failures.map((f) => `  ! ${line(f)}`),
    "",
    "It keeps trying on every run, and work that failed is retried from where it stopped.",
    "While the problem lasts you'll get this at most once a day; it's in the weekly digest too.",
  ];
  const first = input.failures[0]?.message ?? "work runs are failing";
  return { subject: `[fastspam] problem: ${clean(first, 80)}`, text: lines.join("\n") + "\n" };
}
