/**
 * The deterministic ladder. First match wins; only the last rung involves a
 * model. Rungs 3–5 are facts about your own mail, so they cost nothing and an
 * adversarial subject line cannot argue with them.
 *
 *   1  sender matches NEVER_REPORT                   drop
 *   2  fails DMARC, and the From domain publishes      drop
 *      p=quarantine or p=reject (HONOUR_DMARC_POLICY)
 *   2b spam score above SPAM_SCORE_SKIP_ABOVE         drop
 *   3  sender matches ALWAYS_REPORT                   report  (allowlist)
 *   4  you started a conversation with this address   report  (correspondent)
 *   5  thread has mail you received and kept          report  (thread)
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
  | { outcome: "drop"; reason: "never-report" | "dmarc-policy" | "spam-score"; detail: string }
  | { outcome: "report"; basis: Exclude<Basis, "model">; detail: string }
  | { outcome: "model" };

export interface DecideContext {
  neverReport: readonly string[];
  alwaysReport: readonly string[];
  spamScoreSkipAbove: number | null;
  honourDmarcPolicy: boolean;
  correspondents: CorrespondentLookup;
  threadsWithRealMail: ReadonlySet<string>;
  formatDate: (epochMs: number) => string;
}

export function decide(c: Candidate, ctx: DecideContext): Decision {
  const from = c.fromEmail;
  const forged = c.auth.dmarc === "fail";

  const never = from ? matchesAny(from, ctx.neverReport) : undefined;
  if (never) return { outcome: "drop", reason: "never-report", detail: `matches NEVER_REPORT "${never}"` };

  // The domain owner's own published instruction: mail failing its checks is not genuine.
  if (ctx.honourDmarcPolicy && forged && (c.auth.dmarcPolicy === "quarantine" || c.auth.dmarcPolicy === "reject")) {
    return { outcome: "drop", reason: "dmarc-policy", detail: `fails DMARC; the sender's domain publishes p=${c.auth.dmarcPolicy}` };
  }

  if (ctx.spamScoreSkipAbove !== null && c.spamScore !== null && c.spamScore > ctx.spamScoreSkipAbove) {
    return { outcome: "drop", reason: "spam-score", detail: `spam score ${c.spamScore} > ${ctx.spamScoreSkipAbove}` };
  }

  if (from && !forged) {
    const always = matchesAny(from, ctx.alwaysReport);
    if (always) return { outcome: "report", basis: "allowlist", detail: `Sender matches ALWAYS_REPORT "${always}"` };

    const started = ctx.correspondents.started(from);
    if (started !== undefined) {
      return { outcome: "report", basis: "correspondent", detail: `You have started conversations with this address (last on ${ctx.formatDate(started)})` };
    }
  }

  if (c.threadId && ctx.threadsWithRealMail.has(c.threadId)) {
    return { outcome: "report", basis: "thread", detail: "Part of a conversation that has mail you received and kept" };
  }

  return { outcome: "model" };
}
