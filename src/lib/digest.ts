import { TIERS, type Candidate, type RescueResult, type Tier } from "../types.ts";
import type { Message } from "../notify/notifier.ts";
import type { Failure, PendingSuspect } from "./state.ts";
import { failureFormatter } from "./alert.ts";
import { clean, LIMITS } from "./sanitise.ts";
import { dateFormatter, isoDate } from "./time.ts";

/** What the digest reports about the period since the last one. */
export interface RunStats {
  /** Spam messages reviewed in the period. */
  reviewed: number;
  /** Start of the period (the last digest). */
  since: Date;
  droppedByRule: number;
  settledByFact: number;
  sentToModel: number;
  modelCalls: number;
  model: string;
  failures: Failure[];
  notes: string[];
  /** Set while the first pass through Spam is still running. */
  backlog?: { reviewedThrough: Date | null; remaining: number | null };
  /** Set while Sent history is still being indexed. */
  indexing?: { indexed: number; total: number | null };
  /** Finds left out because they had already left Spam. */
  leftSpam?: number;
  /** The incoming check's week, when it is switched on. */
  incoming?: { checked: number; flagged: number };
}

/** Everything the digest needs about a find; a full Suspect fits too. */
export type DigestSuspect = Omit<PendingSuspect, "moved">;
type Linkable = Pick<Candidate, "id" | "threadId">;

export interface DigestInput {
  suspects: DigestSuspect[];
  rescue?: RescueResult;
  rescueMailboxName?: string;
  stats: RunStats;
  now: Date;
  timezone: string;
  sendWhenEmpty: boolean;
  link: (c: Linkable) => string | undefined;
}

const MAX_PER_SECTION = 50;

export { dateFormatter };

/**
 * Plain text, short lines, readable on a phone. Facts come before model
 * judgements, and every line says which it is. Message text is sanitised again
 * here: the digest is one more place untrusted text lands.
 */
export const TIER_LABEL: Record<Tier, string> = {
  important: "🔴 IMPORTANT",
  general: "🟠 WORTH A LOOK",
  promotional: "🔵 PROMOTIONS",
};
const TIER_NOUN: Record<Tier, [string, string]> = {
  important: ["important", "important"],
  general: ["worth a look", "worth a look"],
  promotional: ["promotion", "promotions"],
};

export function renderDigest(input: DigestInput): Message | null {
  const { suspects, stats, rescue } = input;
  const fmt = dateFormatter(input.timezone);
  if (!suspects.length && !stats.failures.length && !input.sendWhenEmpty) return null;
  const moved = new Set(rescue?.moved ?? []);
  const score = (s: DigestSuspect) => s.verdict?.notSpam ?? 1;

  const lines: string[] = [];
  const sender = (s: DigestSuspect) => {
    const name = clean(s.candidate.fromName, LIMITS.name);
    const addr = clean(s.candidate.fromEmail, LIMITS.address) || "(no sender)";
    return name ? `${name} <${addr}>` : addr;
  };
  const why = (s: DigestSuspect) => {
    if (s.basis !== "model" || !s.verdict) return s.detail;
    const pct = Math.round(s.verdict.notSpam * 100);
    return s.verdict.category ? `${s.verdict.category} · ${pct}% not spam (model)` : `${pct}% likely legitimate (model)`;
  };
  const full = (s: DigestSuspect) => {
    const c = s.candidate;
    const received = Date.parse(c.receivedAt);
    lines.push(`• ${clean(c.subject, LIMITS.subject) || "(no subject)"}`);
    lines.push(`  ${sender(s)}${Number.isFinite(received) ? ` · ${fmt(received)}` : ""}`);
    lines.push(`  ${why(s)}`);
    if (moved.has(c.id)) lines.push(`  → moved to ${input.rescueMailboxName ?? "the rescue folder"}`);
    const link = input.link(c);
    if (link) lines.push(`  ${link}`);
    lines.push("");
  };
  // Promotions are listed briefly: they matter least.
  const brief = (s: DigestSuspect) => {
    const c = s.candidate;
    lines.push(`• ${clean(c.subject, 80) || "(no subject)"} · ${clean(c.fromEmail, LIMITS.address)}${moved.has(c.id) ? " → moved" : ""}`);
    const link = input.link(c);
    if (link) lines.push(`  ${link}`);
  };

  const byTier = (t: Tier) =>
    suspects
      .filter((s) => s.tier === t)
      // Facts first, then the model's most confident.
      .sort((a, b) => Number(a.basis === "model") - Number(b.basis === "model") || score(b) - score(a));

  if (suspects.length) {
    lines.push(`fastspam found ${suspects.length} message${suspects.length === 1 ? "" : "s"} in Spam that may be legitimate.`, "");
  } else {
    lines.push("Nothing in Spam looks legitimate this time.", "");
  }
  const counts: string[] = [];
  for (const t of TIERS) {
    const list = byTier(t);
    if (!list.length) continue;
    counts.push(`${list.length} ${TIER_NOUN[t][list.length === 1 ? 0 : 1]}`);
    lines.push(`${TIER_LABEL[t]} (${list.length})`, "");
    for (const s of list.slice(0, MAX_PER_SECTION)) (t === "promotional" ? brief : full)(s);
    if (list.length > MAX_PER_SECTION) lines.push(`… and ${list.length - MAX_PER_SECTION} more`);
    if (t === "promotional") lines.push("");
  }

  if (rescue?.skipped.length) {
    lines.push(`NOT MOVED (${rescue.skipped.length})`);
    for (const k of rescue.skipped.slice(0, MAX_PER_SECTION)) lines.push(`  ${k.id}: ${k.reason}`);
    lines.push("");
  }

  lines.push("—");
  lines.push(`Reviewed ${stats.reviewed} message${stats.reviewed === 1 ? "" : "s"} in Spam since ${fmt(stats.since)}.`);
  lines.push(
    `${stats.settledByFact} reported on facts, ${stats.droppedByRule} dropped by rules, ${stats.sentToModel} sent to ${stats.model}` +
      (stats.sentToModel ? ` in ${stats.modelCalls} call${stats.modelCalls === 1 ? "" : "s"}` : "") +
      ".",
  );
  if (stats.indexing) {
    const of = stats.indexing.total !== null ? ` of ${stats.indexing.total}` : "";
    lines.push(`Still indexing your Sent mail (${stats.indexing.indexed}${of} messages). Spam review starts when that's done.`);
  }
  if (stats.backlog) {
    const through = stats.backlog.reviewedThrough ? `reviewed up to ${fmt(stats.backlog.reviewedThrough)}` : "not started yet";
    const left = stats.backlog.remaining !== null ? `, about ${stats.backlog.remaining} to go` : "";
    lines.push(`Still working through older Spam: ${through}${left}.`);
  }
  if (stats.leftSpam) {
    lines.push(`${stats.leftSpam} earlier find${stats.leftSpam === 1 ? " has" : "s have"} already left Spam and ${stats.leftSpam === 1 ? "isn't" : "aren't"} listed.`);
  }
  if (stats.incoming) {
    const { checked, flagged } = stats.incoming;
    lines.push(`Incoming check: ${checked} new message${checked === 1 ? "" : "s"} checked, ${flagged} flagged as possible spam (sent in the incoming reports).`);
  }
  for (const n of stats.notes) lines.push(`Note: ${n}`);
  if (stats.failures.length) {
    lines.push("", "Problems since the last digest:");
    const failure = failureFormatter(input.timezone);
    for (const f of stats.failures) lines.push(`  ! ${failure(f)}`);
  }

  const date = isoDate(input.now, input.timezone);
  const subject = suspects.length
    ? `[fastspam] ${counts.join(", ")} in ${stats.reviewed} spam (${date})`
    : `[fastspam] nothing to rescue in ${stats.reviewed} spam (${date})${stats.failures.length ? " with problems" : ""}`;
  return { subject, text: lines.join("\n") + "\n" };
}

/** Fill FASTMAIL_LINK_TEMPLATE from values code already holds. Empty template = no links. */
export function makeLinker(template: string, vars: { accountId: string; mailboxId: string; mailboxName: string }) {
  if (!template) return () => undefined;
  return (c: Linkable) =>
    template.replace(/\{(id|threadId|mailboxId|mailboxName|accountId)\}/g, (_, k: string) => {
      const v = k === "id" ? c.id : k === "threadId" ? c.threadId : vars[k as keyof typeof vars];
      return encodeURIComponent(v);
    });
}
