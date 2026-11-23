/**
 * Checking incoming mail for spam the filter missed: the Spam review run in
 * reverse. Facts settle what they can, the rest goes to the same decision
 * model, and a message is flagged only when the model is confident it is spam
 * (the base rate is the other way round here: most incoming mail is
 * legitimate, so a loose threshold would be noisy).
 *
 * Nothing here changes mail; moving finds to QUARANTINE_MAILBOX is
 * jmap/quarantine.ts, and only when that is set.
 */
import type { Candidate } from "./types.ts";
import type { CorrespondentLookup } from "./jmap/correspondents.ts";
import { matchesAny } from "./lib/match.ts";

export type IncomingDecision =
  | { outcome: "skip"; reason: "self" | "trusted" | "correspondent" | "known-domain" | "conversation"; detail: string }
  | { outcome: "flag"; basis: "dmarc-policy" | "spam-sender" | "your-spam-sender"; detail: string }
  | { outcome: "model" };

export interface IncomingContext {
  trustedSenders: readonly string[];
  spamSenders: readonly string[];
  honourDmarcPolicy: boolean;
  correspondents: CorrespondentLookup;
  /** Threads with a message you sent. */
  threadsWithYourMail: ReadonlySet<string>;
}

export function decideIncoming(c: Candidate, ctx: IncomingContext): IncomingDecision {
  const from = c.fromEmail;
  // A failed DMARC check means the From address can't be trusted, so no
  // sender-based fact applies.
  const forged = c.auth.dmarc === "fail";

  if (ctx.honourDmarcPolicy && forged && (c.auth.dmarcPolicy === "quarantine" || c.auth.dmarcPolicy === "reject")) {
    return { outcome: "flag", basis: "dmarc-policy", detail: `fails DMARC, and the sender's domain says to ${c.auth.dmarcPolicy} such mail` };
  }
  if (from && !forged) {
    if (ctx.correspondents.isSelf(from)) return { outcome: "skip", reason: "self", detail: "from one of your own addresses" };
    const always = matchesAny(from, ctx.trustedSenders);
    if (always) return { outcome: "skip", reason: "trusted", detail: `sender matches TRUSTED_SENDERS "${always}"` };
    if (ctx.correspondents.started(from) !== undefined) {
      return { outcome: "skip", reason: "correspondent", detail: "you have started conversations with this address" };
    }
    // Your own judgement, and more specific than the domain and conversation
    // facts below: you may have replied to them before moving their mail to Spam.
    if (ctx.correspondents.movedToSpam(from)) {
      return { outcome: "flag", basis: "your-spam-sender", detail: "you've moved mail from this sender to Spam before" };
    }
    // An organisation you have written to, and DMARC proves the mail really
    // came from its domain. Webmail domains never count (lib/freemail.ts). The
    // only spam this lets through is from a compromised account there.
    if (c.auth.dmarc === "pass" && ctx.correspondents.startedDomain(from)) {
      return { outcome: "skip", reason: "known-domain", detail: "DMARC-verified mail from a domain you have written to" };
    }
  }
  if (c.threadId && ctx.threadsWithYourMail.has(c.threadId)) {
    return { outcome: "skip", reason: "conversation", detail: "part of a conversation you have written in" };
  }
  if (from) {
    const never = matchesAny(from, ctx.spamSenders);
    if (never) return { outcome: "flag", basis: "spam-sender", detail: `sender matches SPAM_SENDERS "${never}"` };
  }
  return { outcome: "model" };
}
