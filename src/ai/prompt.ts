import type { Candidate } from "../types.ts";
import type { PromptMessage } from "./classifier.ts";
import { clean, cleanAddress, LIMITS } from "../lib/sanitise.ts";

/** Build the model-facing view of a message. Every string is sanitised here. */
export function promptMessage(c: Candidate, opts: { now: Date; domainKnown: boolean; repliedBefore: boolean; previewChars: number }): PromptMessage {
  const received = Date.parse(c.receivedAt);
  const auth = (["spf", "dkim", "dmarc"] as const)
    .filter((k) => c.auth[k])
    .map((k) => `${k}=${c.auth[k]}`)
    .join(" ")
    .concat(c.auth.dmarcPolicy ? ` (domain policy ${c.auth.dmarcPolicy})` : "")
    .trim();
  const msg: PromptMessage = {
    from_name: clean(c.fromName, LIMITS.name),
    from_address: cleanAddress(c.fromEmail),
    subject: clean(c.subject, LIMITS.subject),
    received_days_ago: Number.isFinite(received) ? Math.max(0, Math.floor((opts.now.getTime() - received) / 86_400_000)) : null,
    domain_known: opts.domainKnown,
    replied_before: opts.repliedBefore,
    spam_score: c.spamScore,
    auth,
  };
  if (opts.previewChars > 0 && c.preview) msg.preview = clean(c.preview, Math.min(opts.previewChars, LIMITS.preview));
  return msg;
}
