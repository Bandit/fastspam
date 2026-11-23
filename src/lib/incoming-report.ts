import type { Message } from "../notify/notifier.ts";
import type { IncomingFind, IncomingStats } from "./state.ts";
import { clean, LIMITS } from "./sanitise.ts";
import { isUtc, timeFormatter } from "./time.ts";

export interface IncomingReportInput {
  finds: IncomingFind[];
  stats: IncomingStats;
  since: Date;
  now: Date;
  timezone: string;
  /** mailbox id → "Parent/Child" path */
  folderName: (mailboxId: string) => string;
  link: (f: IncomingFind) => string | undefined;
  /** Finds left out because you moved, deleted or read them first. */
  dealtWith: number;
}

const MAX_LISTED = 50;

/**
 * The incoming report: plain text, like the digest, saying why each message
 * was flagged. Quarantined messages come first, so a false positive is easy to
 * spot and move back. Message text is sanitised again here. Facts (DMARC,
 * SPAM_SENDERS, senders you moved to Spam) come before model judgements; the model's most certain
 * first.
 */
export function renderIncomingReport(input: IncomingReportInput): Message {
  const { finds, stats } = input;
  const when = timeFormatter(input.timezone);
  const zone = isUtc(input.timezone) ? " UTC" : "";
  const order = (a: IncomingFind, b: IncomingFind) =>
    Number(a.basis === "model") - Number(b.basis === "model") || (b.pSpam ?? 1) - (a.pSpam ?? 1);
  const moved = finds.filter((f) => f.movedTo).sort(order);
  const left = finds.filter((f) => !f.movedTo).sort(order);
  const n = finds.length;
  const lines = [`fastspam flagged ${n} message${n === 1 ? "" : "s"} that reached your mail but may be spam, a scam or phishing.`, ""];

  let listed = 0;
  const item = (f: IncomingFind) => {
    if (listed++ >= MAX_LISTED) return;
    const c = f.candidate;
    const name = clean(c.fromName, LIMITS.name);
    const addr = clean(c.fromEmail, LIMITS.address) || "(no sender)";
    const received = Date.parse(c.receivedAt);
    lines.push(`• ${clean(c.subject, LIMITS.subject) || "(no subject)"}`);
    lines.push(`  ${name ? `${name} <${addr}>` : addr}`);
    const where = f.movedTo ? `${input.folderName(f.mailboxId)} → ${input.folderName(f.movedTo)}` : input.folderName(f.mailboxId);
    lines.push(`  ${where}${Number.isFinite(received) ? ` · ${when(received)}${zone}` : ""}`);
    lines.push(`  ${f.basis === "model" && f.pSpam !== undefined ? `${Math.round(f.pSpam * 100)}% likely spam (model)` : f.detail}`);
    if (f.notMoved) lines.push(`  not moved: ${f.notMoved}`);
    const link = input.link(f);
    if (link) lines.push(`  ${link}`);
    lines.push("");
  };
  if (moved.length) {
    lines.push(`MOVED TO QUARANTINE (${moved.length}): if one is real mail, move it back.`, "");
    moved.forEach(item);
  }
  if (left.length) {
    if (moved.length) lines.push(`LEFT WHERE THEY ARE (${left.length})`, "");
    left.forEach(item);
  }
  if (n > MAX_LISTED) lines.push(`… and ${n - MAX_LISTED} more`, "");

  lines.push("—");
  lines.push(
    `Checked ${stats.checked} new message${stats.checked === 1 ? "" : "s"} since ${when(input.since.getTime())}${zone}: ` +
      `${stats.settledByFact} cleared on facts, ${stats.sentToModel} sent to the model.`,
  );
  if (input.dealtWith) {
    lines.push(`${input.dealtWith} other find${input.dealtWith === 1 ? " was" : "s were"} left out: you had already moved, deleted or read ${input.dealtWith === 1 ? "it" : "them"}.`);
  }
  lines.push(
    moved.length
      ? "Nothing was deleted. A model can be wrong, so check the quarantined messages."
      : "Nothing was moved. A model can be wrong, so judge for yourself.",
  );
  const stamp = `${when(input.now.getTime())}${zone}`;
  const subject = moved.length
    ? `[fastspam] ${n} possible spam in your mail, ${moved.length} quarantined (${stamp})`
    : `[fastspam] ${n} possible spam in your mail (${stamp})`;
  return { subject, text: lines.join("\n") + "\n" };
}
