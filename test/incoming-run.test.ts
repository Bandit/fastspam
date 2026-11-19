import { describe, expect, it } from "vitest";
import { digest, run, work, type IncomingReport, type WorkReport } from "../src/pipeline.ts";
import type { JobState } from "../src/lib/state.ts";
import type { Message, Notifier } from "../src/notify/notifier.ts";
import type { Env } from "../src/types.ts";
import { dist, FakeAi, FakeJmap, MAILBOXES, MemoryKV, payloadMessages, sentEmail, testEnv, type FakeEmail } from "./helpers.ts";

// Friday 20 Nov 2026; the weekly digest (Mondays 20:00 UTC) is days away.
const T0 = new Date("2026-11-20T09:00:00Z");
const MIN = 60_000;
const at = (minutes: number) => new Date(T0.getTime() + minutes * MIN);

class Recorder implements Notifier {
  readonly name = "recorder";
  sent: Message[] = [];
  async send(m: Message) {
    this.sent.push(m);
  }
}

const quiet = { log: () => {} };
const BOXES = [...MAILBOXES, { id: "mb-work", name: "Work", role: null, parentId: null }, { id: "mb-work-in", name: "Inbox", role: null, parentId: "mb-work" }];

let seq = 0;
/** Mail arriving `minutes` after T0 in a checked folder. */
function arriving(minutes: number, from: string, subject: string, extra: Partial<FakeEmail> = {}): FakeEmail {
  seq++;
  return {
    id: `I${seq}`,
    threadId: `IT${seq}`,
    mailboxIds: { "mb-inbox": true },
    from: [{ email: from }],
    subject,
    receivedAt: at(minutes).toISOString(),
    preview: "",
    headers: { "authentication-results": ["mx.messagingengine.com; spf=pass; dkim=pass; dmarc=pass"] },
    ...extra,
  };
}

function setup(over: Record<string, unknown> = {}) {
  const fake = new FakeJmap({ mailboxes: BOXES, emails: [sentEmail("friend@client.example", 30, undefined, T0)] });
  const ai = new FakeAi((m) =>
    /verify|suspended/i.test(m.subject) ? { choice: "spam", probabilities: dist("spam", 0.95) } : { choice: "newsletter", probabilities: dist("newsletter", 0.8) },
  );
  const notifier = new Recorder();
  const env = testEnv({ AI: ai, INCOMING_MAILBOXES: "Inbox, Work.Inbox", ...over });
  const go = (minutes: number) => run(env, at(minutes), { fetchImpl: fake.fetch, notifier, ...quiet });
  return { fake, ai, notifier, env, go };
}

function jobOf(env: Env): JobState {
  return JSON.parse((env.FASTSPAM_STATE as unknown as MemoryKV).store.get("job")!);
}

/** Index Sent, catch up on (empty) Spam and start the incoming position at T0. */
async function started(s: ReturnType<typeof setup>) {
  for (let i = 0; i < 5; i++) await s.go(0);
  expect(jobOf(s.env).incoming?.cursor).toBe(at(-10).toISOString());
}

describe("incoming check", () => {
  it("is off unless INCOMING_MAILBOXES is set", async () => {
    const s = setup({ INCOMING_MAILBOXES: "" });
    s.fake.emails.push(arriving(-60, "stranger@cold.example", "Verify your account"));
    for (let i = 0; i < 5; i++) await s.go(30);
    expect(jobOf(s.env).incoming).toBeUndefined();
    expect(s.ai.calls).toHaveLength(0);
  });

  it("starts with mail arriving after it is switched on", async () => {
    const s = setup();
    s.fake.emails.push(arriving(-60, "stranger@cold.example", "Verify your account"));
    await started(s);
    await s.go(30);
    expect(s.ai.calls).toHaveLength(0);
  });

  it("settles known senders on facts and flags what the model is sure is spam", async () => {
    const s = setup();
    await started(s);
    const friend = arriving(1, "friend@client.example", "Lunch?");
    const colleague = arriving(2, "someone.else@client.example", "Invoice attached");
    const phish = arriving(3, "security@account-verify.example", "Verify your account now", { mailboxIds: { "mb-work-in": true } });
    const newsletter = arriving(4, "news@letters.example", "This week in gardening");
    const forged = arriving(5, "ceo@client.example", "Urgent wire", {
      headers: { "authentication-results": ["mx.messagingengine.com; dmarc=fail policy.published-domain-policy=reject header.from=client.example"] },
    });
    s.fake.emails.push(friend, colleague, phish, newsletter, forged);

    const r = (await s.go(20)) as WorkReport;
    expect(r.kind).toBe("work");
    expect(r.incoming).toEqual({ checked: 5, settledByFact: 2, sentToModel: 2, modelCalls: 1, flagged: 2 });
    // Only the cold senders reached the model, framed as incoming mail.
    const payload = String(s.ai.calls[0]!.input.input ?? s.ai.calls[0]!.input.state);
    expect([...payloadMessages(payload).values()].map((m) => m.from_address).sort()).toEqual(["news@letters.example", "security@account-verify.example"]);
    expect(payload).toMatch(/^You are reviewing messages that arrived/);
    expect(jobOf(s.env).incoming!.pending.map((p) => [p.candidate.id, p.basis])).toEqual([
      [forged.id, "dmarc-policy"],
      [phish.id, "model"],
    ]);

    // The next run sends the report, then nothing until there's more to say.
    const rep = (await s.go(35)) as IncomingReport;
    expect(rep).toMatchObject({ kind: "incoming-report", sent: true, listed: 2 });
    expect(s.notifier.sent).toHaveLength(1);
    const text = s.notifier.sent[0]!.text;
    expect(s.notifier.sent[0]!.subject).toMatch(/^\[fastspam\] 2 possible spam in your mail/);
    expect(text).toContain("Verify your account now");
    expect(text).toContain("Work/Inbox");
    expect(text).toContain("95% likely spam (model)");
    expect(text).toContain("fails DMARC");
    expect(text).toContain("Checked 5 new messages");
    expect(text).not.toContain("Lunch?");
    expect((await s.go(50)).kind).toBe("work");
    expect(s.ai.calls).toHaveLength(1);
  });

  it("reports at most once per INCOMING_REPORT_MINUTES", async () => {
    const s = setup();
    await started(s);
    s.fake.emails.push(arriving(1, "a@scam.example", "Account suspended"));
    await s.go(15);
    expect((await s.go(30)).kind).toBe("incoming-report");
    s.fake.emails.push(arriving(31, "b@scam.example", "Verify now"));
    await s.go(45);
    expect(jobOf(s.env).incoming!.pending).toHaveLength(1);
    expect((await s.go(60)).kind).toBe("work");
    expect((await s.go(75)).kind).toBe("work");
    expect((await s.go(90)).kind).toBe("incoming-report");
    expect(s.notifier.sent).toHaveLength(2);
  });

  it("leaves out its own reports and what you dealt with before the report", async () => {
    const s = setup({ INCOMING_SKIP_READ: "true" });
    await started(s);
    const own = arriving(1, "fastspam@owner.example", "[fastspam] 3 possible spam", { headers: { "x-fastspam": ["digest"] } });
    const read = arriving(2, "c@scam.example", "Verify your password", { keywords: { $seen: true } });
    const movedLater = arriving(3, "d@scam.example", "Account suspended");
    const readLater = arriving(4, "e@scam.example", "Verify your card");
    s.fake.emails.push(own, read, movedLater, readLater);
    const r = (await s.go(20)) as WorkReport;
    expect(r.incoming).toMatchObject({ checked: 2, flagged: 2 });

    movedLater.mailboxIds = { "mb-junk": true };
    readLater.keywords = { $seen: true };
    const rep = (await s.go(35)) as IncomingReport;
    expect(rep).toMatchObject({ kind: "incoming-report", sent: false, listed: 0, dealtWith: 2 });
    expect(s.notifier.sent).toHaveLength(0);
    expect(jobOf(s.env).incoming!.pending).toHaveLength(0);
  });

  it("keeps a message the model couldn't answer for the next run", async () => {
    const s = setup();
    await started(s);
    s.fake.emails.push(arriving(1, "a@scam.example", "Verify now"));
    s.ai.failWith = new Error("upstream 500");
    const r = (await s.go(15)) as WorkReport;
    expect(r.incoming).toMatchObject({ checked: 0 });
    expect(r.failures.join(" ")).toMatch(/incoming/);
    s.ai.failWith = undefined;
    expect(((await s.go(30)) as WorkReport).incoming).toMatchObject({ checked: 1, flagged: 1 });
  });

  it("records a bad folder name without holding up the Spam review", async () => {
    const s = setup({ INCOMING_MAILBOXES: "Nope" });
    const reports = [] as WorkReport[];
    for (let i = 0; i < 4; i++) reports.push((await s.go(0)) as WorkReport);
    expect(reports.at(-1)!.failures.join(" ")).toMatch(/incoming check failed: INCOMING_MAILBOXES mailbox "Nope" not found/);
    expect(jobOf(s.env).spam.caughtUpAt).toBeDefined();
  });

  it("refuses to treat Spam as incoming", async () => {
    const s = setup({ INCOMING_MAILBOXES: "Inbox, Spam" });
    const reports = [] as WorkReport[];
    for (let i = 0; i < 4; i++) reports.push((await s.go(0)) as WorkReport);
    expect(reports.at(-1)!.failures.join(" ")).toMatch(/must not include Spam/);
  });

  it("adds the week's incoming numbers to the weekly digest", async () => {
    const s = setup();
    await started(s);
    s.fake.emails.push(arriving(1, "a@scam.example", "Verify now"), arriving(2, "friend@client.example", "Hi"));
    await s.go(15);
    const d = await digest(s.env, at(30), { fetchImpl: s.fake.fetch, notifier: s.notifier, ...quiet });
    expect(d.message!.text).toContain("Incoming check: 2 new messages checked, 1 flagged");
    expect(jobOf(s.env).incoming!.week).toMatchObject({ checked: 0, flagged: 0 });
  });
});

it("work() alone never sends an incoming report", async () => {
  const s = setup();
  await started(s);
  s.fake.emails.push(arriving(1, "a@scam.example", "Verify now"));
  await s.go(15);
  await work(s.env, at(30), { fetchImpl: s.fake.fetch, notifier: s.notifier, ...quiet });
  expect(s.notifier.sent).toHaveLength(0);
});
