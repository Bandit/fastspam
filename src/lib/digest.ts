import { TIERS, type Candidate, type RescueResult, type Suspect, type Tier } from "../types.ts";
import type { Message } from "../notify/notifier.ts";
import { notSpam } from "../ai/classifier.ts";
import { clean, LIMITS } from "./sanitise.ts";

export interface RunStats {
  /** Messages in Spam inside the window, as the server counted them. */
  inWindow: number;
  /** Fetched this run and not reviewed before. */
  fresh: number;
  since: Date;
  droppedByRule: number;
  settledByFact: number;
  sentToModel: number;
  classified: number;
  unclassified: number;
  modelCalls: number;
  model: string;
  failures: string[];
  notes: string[];
}

export interface DigestInput {
  suspects: Suspect[];
  rescue?: RescueResult;
  rescueMailboxName?: string;
  stats: RunStats;
  now: Date;
  timezone: string;
  sendWhenEmpty: boolean;
  link: (c: Candidate) => string | undefined;
}

const MAX_PER_SECTION = 50;

export function dateFormatter(timezone: string): (d: Date | number) => string {
  const f = new Intl.DateTimeFormat("en-GB", { timeZone: timezone, weekday: "short", day: "numeric", month: "short", year: "numeric" });
  return (d) => f.format(typeof d === "number" ? new Date(d) : d);
}

function isoDate(d: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
}

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
  const score = (s: Suspect) => (s.verdict ? notSpam(s.verdict) : 1);

  const lines: string[] = [];
  const sender = (s: Suspect) => {
    const name = clean(s.candidate.fromName, LIMITS.name);
    const addr = clean(s.candidate.fromEmail, LIMITS.address) || "(no sender)";
    return name ? `${name} <${addr}>` : addr;
  };
  const why = (s: Suspect) => {
    if (s.basis !== "model" || !s.verdict) return s.detail;
    const pct = Math.round(notSpam(s.verdict) * 100);
    return s.verdict.category ? `${s.verdict.category} · ${pct}% not spam (model)` : `${pct}% likely legitimate (model)`;
  };
  const full = (s: Suspect) => {
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
  const brief = (s: Suspect) => {
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
  lines.push(`Reviewed ${stats.fresh} new message${stats.fresh === 1 ? "" : "s"} in Spam since ${fmt(stats.since)} (${stats.inWindow} in the window).`);
  lines.push(
    `${stats.settledByFact} reported on facts, ${stats.droppedByRule} dropped by rules, ${stats.sentToModel} sent to ${stats.model}` +
      (stats.sentToModel ? ` in ${stats.modelCalls} call${stats.modelCalls === 1 ? "" : "s"}` : "") +
      (stats.unclassified ? `, ${stats.unclassified} left unclassified (retried next run)` : "") +
      ".",
  );
  for (const n of stats.notes) lines.push(`Note: ${n}`);
  if (stats.failures.length) {
    lines.push("", "Problems this run:");
    for (const f of stats.failures) lines.push(`  ! ${f}`);
  }

  const date = isoDate(input.now, input.timezone);
  const subject = suspects.length
    ? `[fastspam] ${counts.join(", ")} in ${stats.fresh} spam (${date})`
    : `[fastspam] nothing to rescue in ${stats.fresh} spam (${date})${stats.failures.length ? " with problems" : ""}`;
  return { subject, text: lines.join("\n") + "\n" };
}

/** Fill FASTMAIL_LINK_TEMPLATE from values code already holds. Empty template = no links. */
export function makeLinker(template: string, vars: { accountId: string; mailboxId: string; mailboxName: string }) {
  if (!template) return () => undefined;
  return (c: Candidate) =>
    template.replace(/\{(id|threadId|mailboxId|mailboxName|accountId)\}/g, (_, k: string) => {
      const v = k === "id" ? c.id : k === "threadId" ? c.threadId : vars[k as keyof typeof vars];
      return encodeURIComponent(v);
    });
}
