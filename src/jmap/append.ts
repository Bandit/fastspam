import type { JmapClient } from "./client.ts";

export const FASTSPAM_HEADER = "X-Fastspam";

/**
 * Deliver the digest by creating it directly in the Inbox with Email/set
 * (RFC 8621 §4.6). Nothing is sent over SMTP, so there is no sender domain,
 * SPF or deliverability to set up. Needs a token with the Email scope.
 */
export async function appendToInbox(
  client: JmapClient,
  msg: { subject: string; text: string; from: string; to: string[] },
): Promise<void> {
  const { accountId } = await client.session();
  const boxes = await client.request([["Mailbox/query", { accountId, filter: { role: "inbox" } }, "m"]]);
  const inboxId = (boxes.get("m")?.ids as string[] | undefined)?.[0];
  if (!inboxId) throw new Error("Fastmail notifier: no Inbox found for the write token's account");

  const res = await client.request([
    [
      "Email/set",
      {
        accountId,
        create: {
          digest: {
            mailboxIds: { [inboxId]: true },
            from: [{ name: "fastspam", email: msg.from || "fastspam@invalid" }],
            ...(msg.to.length ? { to: msg.to.map((email) => ({ email })) } : {}),
            subject: msg.subject,
            // Lets a scan of incoming mail recognise fastspam's own reports.
            [`header:${FASTSPAM_HEADER}:asText`]: "digest",
            bodyValues: { body: { value: msg.text } },
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
