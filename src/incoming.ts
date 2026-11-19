/**
 * Checking incoming mail for spam the filter missed: the Spam review run in
 * reverse. Facts settle what they can, the rest goes to the same decision
 * model, and a message is flagged only when the model is confident it is spam
 * (the base rate is the other way round here: most incoming mail is
 * legitimate, so a loose threshold would be noisy).
 *
 * Read-only: nothing here changes mail.
 */
import type { Candidate } from "./types.ts";
import type { CorrespondentLookup } from "./jmap/correspondents.ts";
import { matchesAny } from "./lib/match.ts";

export type IncomingDecision =
  | { outcome: "skip"; reason: "self" | "allowlist" | "correspondent" | "known-domain" | "conversation"; detail: string }
  | { outcome: "flag"; basis: "dmarc-policy" | "blocklist"; detail: string }
  | { outcome: "model" };

export interface IncomingContext {
  alwaysReport: readonly string[];
  neverReport: readonly string[];
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
    const always = matchesAny(from, ctx.alwaysReport);
    if (always) return { outcome: "skip", reason: "allowlist", detail: `sender matches ALWAYS_REPORT "${always}"` };
    if (ctx.correspondents.started(from) !== undefined) {
      return { outcome: "skip", reason: "correspondent", detail: "you have started conversations with this address" };
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
    const never = matchesAny(from, ctx.neverReport);
    if (never) return { outcome: "flag", basis: "blocklist", detail: `sender matches NEVER_REPORT "${never}"` };
  }
  return { outcome: "model" };
}
