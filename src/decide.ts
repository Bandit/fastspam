/**
 * The deterministic ladder. First match wins; only the last rung involves a
 * model. Rungs 3–5 are facts about your own mail, so they cost nothing and an
 * adversarial subject line cannot argue with them.
 *
 *   1  sender matches SPAM_SENDERS                   drop
 *   2  fails DMARC, and the From domain publishes      drop
 *      p=quarantine or p=reject (HONOUR_DMARC_POLICY)
 *   2a spam score below SPAM_FILTER_THRESHOLD: the    drop
 *      filter didn't put it here, so you (or your
 *      rules) did
 *   2b spam score above SPAM_SCORE_SKIP_ABOVE         drop
 *   2c read, with SPAM_SKIP_READ                      drop
 *   3  sender matches TRUSTED_SENDERS                 report  (trusted)
 *   4  you started a conversation with this address   report  (correspondent)
 *   5  thread has mail you received and kept          report  (thread)
 *   5a you've moved mail from this sender to Spam     drop
 *      yourself before
 *   6  anything else                                  ask the model
 *
 * "Started", not "sent to": a reply proves little, since people reply to
 * spammers. Addresses you have only replied to go to the model with that as a
 * hint (replied_before). Likewise rung 5 ignores your own messages in a thread.
 *
 * Rungs 3 and 4 trust the From address, which senders can forge. They are
 * skipped when the receiving server's DMARC verdict is "fail", so a forged
 * From goes to the model (with that auth result) instead of being waved through.
 */
import type { Basis, Candidate } from "./types.ts";
import type { CorrespondentLookup } from "./jmap/correspondents.ts";
import { matchesAny } from "./lib/match.ts";

export type Decision =
  | { outcome: "drop"; reason: "spam-sender" | "dmarc-policy" | "moved-by-you" | "spam-score" | "read" | "your-spam-sender"; detail: string }
  | { outcome: "report"; basis: Exclude<Basis, "model">; detail: string }
  | { outcome: "model" };

export interface DecideContext {
  spamSenders: readonly string[];
  trustedSenders: readonly string[];
  spamScoreSkipAbove: number | null;
  /** 0 = off. */
  spamFilterThreshold?: number;
  /** Drop read messages (SPAM_SKIP_READ, unless all of Spam is marked read anyway). */
  skipRead?: boolean;
  honourDmarcPolicy: boolean;
  correspondents: CorrespondentLookup;
  threadsWithRealMail: ReadonlySet<string>;
  formatDate: (epochMs: number) => string;
}

export function decide(c: Candidate, ctx: DecideContext): Decision {
  const from = c.fromEmail;
  const forged = c.auth.dmarc === "fail";

  const never = from ? matchesAny(from, ctx.spamSenders) : undefined;
  if (never) return { outcome: "drop", reason: "spam-sender", detail: `matches SPAM_SENDERS "${never}"` };

  // The domain owner's own published instruction: mail failing its checks is not genuine.
  if (ctx.honourDmarcPolicy && forged && (c.auth.dmarcPolicy === "quarantine" || c.auth.dmarcPolicy === "reject")) {
    return { outcome: "drop", reason: "dmarc-policy", detail: `fails DMARC; the sender's domain publishes p=${c.auth.dmarcPolicy}` };
  }

  // Your own judgement: the filter files mail at the threshold, so anything
  // in Spam scoring lower was moved there by you or one of your rules.
  if (ctx.spamFilterThreshold && c.spamScore !== null && c.spamScore < ctx.spamFilterThreshold) {
    return { outcome: "drop", reason: "moved-by-you", detail: `spam score ${c.spamScore} is below the filter's ${ctx.spamFilterThreshold}, so you put it in Spam` };
  }

  if (ctx.spamScoreSkipAbove !== null && c.spamScore !== null && c.spamScore > ctx.spamScoreSkipAbove) {
    return { outcome: "drop", reason: "spam-score", detail: `spam score ${c.spamScore} > ${ctx.spamScoreSkipAbove}` };
  }

  if (ctx.skipRead && c.seen) return { outcome: "drop", reason: "read", detail: "you've read it and left it in Spam" };

  if (from && !forged) {
    const always = matchesAny(from, ctx.trustedSenders);
    if (always) return { outcome: "report", basis: "trusted", detail: `Sender matches TRUSTED_SENDERS "${always}"` };

    const started = ctx.correspondents.started(from);
    if (started !== undefined) {
      return { outcome: "report", basis: "correspondent", detail: `You have started conversations with this address (last on ${ctx.formatDate(started)})` };
    }
  }

  if (c.threadId && ctx.threadsWithRealMail.has(c.threadId)) {
    return { outcome: "report", basis: "thread", detail: "Part of a conversation that has mail you received and kept" };
  }

  // Below the facts above: a sender you've also started a conversation with,
  // or a trusted one, is still reported.
  if (from && !forged && ctx.correspondents.movedToSpam(from)) {
    return { outcome: "drop", reason: "your-spam-sender", detail: "you've moved mail from this sender to Spam yourself" };
  }

  return { outcome: "model" };
}
