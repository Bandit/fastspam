import type { JmapClient } from "./client.ts";
import { findMailbox, listMailboxes } from "./mailboxes.ts";

export const FASTSPAM_HEADER = "X-Fastspam";

/**
 * Deliver a digest, report or alert by creating it directly in a mailbox with
 * Email/set (RFC 8621 §4.6): the Inbox, or DIGEST_MAILBOX. Nothing is sent
 * over SMTP, so there is no sender domain, SPF or deliverability to set up,
 * but your Fastmail rules don't run on it either (they run on delivery).
 * Needs a token with the Email scope.
 *
 * If DIGEST_MAILBOX can't be found the message still goes to the Inbox, saying
 * so at the top: a renamed folder shouldn't silence fastspam.
 */
export async function appendDigest(
  client: JmapClient,
  msg: { subject: string; text: string; from: string; to: string[] },
  opts: { mailbox?: string } = {},
): Promise<void> {
  const { accountId } = await client.session();
  const all = await listMailboxes(client);
  let mailboxId: string | undefined;
  let text = msg.text;
  if (opts.mailbox) {
    try {
      mailboxId = findMailbox(all, opts.mailbox, "DIGEST_MAILBOX").id;
    } catch {
      text = `(DIGEST_MAILBOX "${opts.mailbox}" wasn't found, so this went to your Inbox.)\n\n${text}`;
    }
  }
  mailboxId ??= all.find((m) => m.role === "inbox")?.id;
  if (!mailboxId) throw new Error("Fastmail notifier: no Inbox found for the write token's account");

  const res = await client.request([
    [
      "Email/set",
      {
        accountId,
        create: {
          digest: {
            mailboxIds: { [mailboxId]: true },
            from: [{ name: "fastspam", email: msg.from || "fastspam@invalid" }],
            ...(msg.to.length ? { to: msg.to.map((email) => ({ email })) } : {}),
            subject: msg.subject,
            // Lets a scan of incoming mail recognise fastspam's own reports.
            [`header:${FASTSPAM_HEADER}:asText`]: "digest",
            bodyValues: { body: { value: text } },
            textBody: [{ partId: "body", type: "text/plain" }],
          },
        },
      },
      "s",
    ],
  ]);
  const notCreated = (res.get("s")?.notCreated ?? {}) as Record<string, { type?: string; description?: string }>;
  if (notCreated.digest) {
    throw new Error(`Fastmail notifier: Email/set refused the digest: ${notCreated.digest.type ?? "unknown"} ${notCreated.digest.description ?? ""}`.trim());
  }
}
