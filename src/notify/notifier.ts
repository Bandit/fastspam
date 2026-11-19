import type { JmapClient } from "../jmap/client.ts";
import { appendToInbox } from "../jmap/append.ts";

/** A rendered digest, independent of transport. Plain text only. */
export interface Message {
  subject: string;
  text: string;
}

export interface Notifier {
  readonly name: string;
  send(msg: Message): Promise<void>;
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

/** DRY_RUN and the preview script: print instead of sending. */
export class ConsoleNotifier implements Notifier {
  readonly name = "console";
  async send(msg: Message): Promise<void> {
    console.log(`----- ${msg.subject} -----\n${msg.text}----- end -----`);
  }
}

/** Files the digest straight into your Fastmail Inbox (needs FASTMAIL_WRITE_TOKEN). */
export class FastmailNotifier implements Notifier {
  readonly name = "fastmail";
  private readonly client: JmapClient;
  private readonly from: string;
  private readonly to: string[];
  constructor(client: JmapClient, from: string, to: string[]) {
    this.client = client;
    this.from = from;
    this.to = to;
  }
  async send(msg: Message): Promise<void> {
    await appendToInbox(this.client, { ...msg, from: this.from, to: this.to });
  }
}

/** Postmark (https://postmarkapp.com/developer/api/email-api). */
export class PostmarkNotifier implements Notifier {
  readonly name = "postmark";
  private readonly token: string;
  private readonly from: string;
  private readonly to: string[];
  private readonly stream: string;
  private readonly fetchImpl: FetchImpl;
  constructor(token: string, from: string, to: string[], stream = "outbound", fetchImpl?: FetchImpl) {
    this.token = token;
    this.from = from;
    this.to = to;
    this.stream = stream;
    this.fetchImpl = fetchImpl ?? ((i, init) => fetch(i, init));
  }
  async send(msg: Message): Promise<void> {
    const res = await this.fetchImpl("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "X-Postmark-Server-Token": this.token },
      body: JSON.stringify({
        From: this.from,
        To: this.to.join(","),
        Subject: msg.subject,
        TextBody: msg.text,
        MessageStream: this.stream,
        Tag: "fastspam",
      }),
    });
    if (!res.ok) {
      // Postmark's error only: never echo request headers.
      const body = (await res.json().catch(() => ({}))) as { ErrorCode?: number; Message?: string };
      throw new Error(`Postmark send failed: HTTP ${res.status} ErrorCode ${body.ErrorCode ?? "?"} ${body.Message ?? ""}`.trim());
    }
  }
}

/** Cloudflare Email Service `send_email` binding. */
export class CloudflareEmailNotifier implements Notifier {
  readonly name = "cloudflare";
  private readonly binding: SendEmail;
  private readonly from: string;
  private readonly to: string[];
  constructor(binding: SendEmail, from: string, to: string[]) {
    this.binding = binding;
    this.from = from;
    this.to = to;
  }
  async send(msg: Message): Promise<void> {
    await (this.binding as unknown as { send(m: unknown): Promise<unknown> }).send({
      from: { email: this.from, name: "fastspam" },
      to: this.to,
      subject: msg.subject,
      text: msg.text,
    });
  }
}
