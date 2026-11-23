import { describe, expect, it, vi } from "vitest";
import { digest, run, work, type WorkReport } from "../src/pipeline.ts";
import type { JobState } from "../src/lib/state.ts";
import type { Message, Notifier } from "../src/notify/notifier.ts";
import type { Env } from "../src/types.ts";
import { dist, FakeAi, FakeJmap, MemoryKV, sentEmail, sentReply, spamEmail, testEnv } from "./helpers.ts";

// Monday 23 Nov 2026. The default digest time is Mondays 20:00 in TIMEZONE (UTC).
const START = new Date("2026-11-23T12:00:00Z");
const SLOT = new Date("2026-11-23T20:00:00Z");
const MIN = 60_000;
const at = (d: Date, minutes: number) => new Date(d.getTime() + minutes * MIN);

class Recorder implements Notifier {
  readonly name = "recorder";
  sent: Message[] = [];
  fail = false;
  async send(m: Message) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(m);
  }
}

const quiet = { log: () => {} };

/** Work runs until there is nothing left to do. */
async function workUntilIdle(env: Env, fake: FakeJmap, when = START): Promise<WorkReport[]> {
  const reports: WorkReport[] = [];
  for (let i = 0; i < 60; i++) {
    const r = await work(env, when, { fetchImpl: fake.fetch, ...quiet });
    reports.push(r);
    if (r.idle) return reports;
  }
  throw new Error("work never went idle");
}

function jobOf(env: Env): JobState {
  return JSON.parse((env.FASTSPAM_STATE as unknown as MemoryKV).store.get("job")!);
}

function world() {
  const friend = spamEmail({ from: "friend@mail.example", subject: "Re: dinner" });
  const conversation = spamEmail({ from: "new@person.example", subject: "Re: the quote", threadId: "TQ" });
  const trusted = spamEmail({ from: "billing@trusted.example", subject: "Statement" });
  const blocked = spamEmail({ from: "x@blocked.example", subject: "Blocked" });
  const receipt = spamEmail({ from: "orders@shop.example", subject: "Your receipt" });
  const junk = spamEmail({ from: "win@lottery.example", subject: "You won" });
  const forged = spamEmail({ from: "friend@mail.example", subject: "Urgent wire", headers: { "authentication-results": ["mx.messagingengine.com; dmarc=fail"] } });
  const fake = new FakeJmap({
    emails: [
      friend,
      conversation,
      { ...conversation, id: "Q2", mailboxIds: { "mb-inbox": true } },
      trusted,
      blocked,
      receipt,
      junk,
      forged,
      sentEmail("friend@mail.example", 30),
    ],
  });
  const ai = new FakeAi((m) => (m.subject.includes("receipt") ? { choice: "transactional", probabilities: dist("transactional", 0.9) } : { choice: "spam", probabilities: dist("spam", 0.9) }));
  const env = testEnv({ AI: ai, TRUSTED_SENDERS: "trusted.example", SPAM_SENDERS: "blocked.example" });
  return { fake, ai, env, ids: { friend, conversation, trusted, blocked, receipt, junk, forged } };
}

describe("work runs", () => {
  it("settles facts deterministically and asks the model only about the rest", async () => {
    const { fake, ai, env, ids } = world();
    const reports = await workUntilIdle(env, fake);
    const suspects = reports.flatMap((r) => r.suspects);

    expect(Object.fromEntries(suspects.map((s) => [s.candidate.id, s.basis]))).toEqual({
      [ids.friend.id]: "correspondent",
      [ids.conversation.id]: "thread",
      [ids.trusted.id]: "trusted",
      [ids.receipt.id]: "model",
    });
    // One model call, about exactly the three messages no fact could settle.
    expect(ai.calls).toHaveLength(1);
    expect(Object.keys(ai.calls[0]!.input.questions as object)).toHaveLength(3);
    expect(jobOf(env).stats).toMatchObject({ reviewed: 7, droppedByRule: 1, settledByFact: 3, sentToModel: 3, modelCalls: 1 });
    expect(jobOf(env).pending).toHaveLength(4);
    // The scanning token never wrote anything.
    expect(fake.calls.filter((c) => c.name === "Email/set")).toHaveLength(0);
  });

  it("indexes all of Sent, a page per run, before reviewing any Spam", async () => {
    const sent = Array.from({ length: 25 }, (_, i) => sentEmail(`person${i}@mail.example`, 40 + i));
    const fromLast = spamEmail({ from: "person24@mail.example", subject: "Hello again" });
    const fake = new FakeJmap({ emails: [...sent, fromLast] });
    const env = testEnv({ AI: new FakeAi(), SENT_PAGE: "10" });

    const runs = await workUntilIdle(env, fake);
    expect(runs.map((r) => r.sentIndexed).slice(0, 3)).toEqual([10, 10, 5]);
    // No Spam query until the history was complete.
    const firstJunk = fake.requests.findIndex((r) => r.calls.some((c) => (c[1].filter as { inMailbox?: string })?.inMailbox === "mb-junk"));
    const isHistory = fake.requests.map((r) => r.calls.some((c) => "position" in c[1] && (c[1].filter as { inMailbox?: string })?.inMailbox === "mb-sent"));
    const lastHistory = isHistory.lastIndexOf(true);
    expect(firstJunk).toBeGreaterThan(lastHistory);
    // The oldest Sent message, from the last page, still counts.
    expect(runs.flatMap((r) => r.suspects).map((s) => s.basis)).toEqual(["correspondent"]);
    expect(jobOf(env).sent).toMatchObject({ historyComplete: true, historyIndexed: 25, historyTotal: 25 });
  });

  it("works through a full Spam folder oldest first, a slice per run, reviewing each message once", async () => {
    const spam = Array.from({ length: 100 }, (_, i) => spamEmail({ from: `s${i}@spam.example`, subject: `offer ${i}`, daysAgo: 100 - i }));
    const fake = new FakeJmap({ emails: [...spam] });
    const env = testEnv({ AI: new FakeAi(), SPAM_SLICE: "40" });

    const runs = await workUntilIdle(env, fake);
    const reviewed = runs.flatMap((r) => r.reviewed.map((c) => c.id));
    expect(runs.map((r) => r.reviewed.length)).toEqual([0, 40, 40, 20]);
    expect(reviewed).toEqual(spam.map((e) => e.id));
    expect(jobOf(env).spam.caughtUpAt).toBe(START.toISOString());

    // Steady state: only what arrives later is reviewed.
    const later = { ...spamEmail({ from: "new@spam.example", subject: "new one" }), receivedAt: at(START, 60).toISOString() };
    fake.emails.push(later);
    const next = await workUntilIdle(env, fake, at(START, 120));
    expect(next.flatMap((r) => r.reviewed.map((c) => c.id))).toEqual([later.id]);
  });

  it("neither skips nor repeats messages that share a timestamp across slices", async () => {
    const same = Array.from({ length: 7 }, (_, i) => spamEmail({ from: `t${i}@spam.example`, subject: `tie ${i}`, daysAgo: 2 }));
    const fake = new FakeJmap({ emails: [...same] });
    const env = testEnv({ AI: new FakeAi(), SPAM_SLICE: "3" });
    const runs = await workUntilIdle(env, fake);
    const reviewed = runs.flatMap((r) => r.reviewed.map((c) => c.id));
    expect(reviewed.sort()).toEqual(same.map((e) => e.id).sort());
  });

  it("leaves mail from the last ten minutes for a later run", async () => {
    // Received 5 minutes before the run.
    const fresh = { ...spamEmail({ from: "late@spam.example", subject: "just in" }), receivedAt: at(START, -5).toISOString() };
    const fake = new FakeJmap({ emails: [fresh] });
    const env = testEnv({ AI: new FakeAi() });
    const first = await workUntilIdle(env, fake);
    expect(first.flatMap((r) => r.reviewed)).toHaveLength(0);
    const later = await workUntilIdle(env, fake, at(START, 15));
    expect(later.flatMap((r) => r.reviewed.map((c) => c.id))).toEqual([fresh.id]);
  });

  it("indexes new Sent mail before reviewing Spam that arrives with it", async () => {
    const fake = new FakeJmap({ emails: [sentEmail("old@mail.example", 30)] });
    const env = testEnv({ AI: new FakeAi() });
    await workUntilIdle(env, fake);
    // You write to someone; their reply lands in Spam; both before the next run.
    const t = at(START, 30);
    fake.emails.push({ ...sentEmail("new@person.example", 0, undefined, t), receivedAt: at(START, 1).toISOString() });
    fake.emails.push({ ...spamEmail({ from: "new@person.example", subject: "Re: hello" }, t), receivedAt: at(START, 2).toISOString() });
    const runs = await workUntilIdle(env, fake, t);
    expect(runs.flatMap((r) => r.suspects).map((s) => s.basis)).toEqual(["correspondent"]);
  });

  it("stops at the first message the model couldn't answer, and carries on from there next run", async () => {
    const { fake, env, ids } = world();
    env.MAX_MODEL_CALLS_PER_RUN = "0";
    const first = await workUntilIdle(env, fake).catch(() => undefined);
    expect(first).toBeUndefined(); // never idle: the slice can't finish without the model
    const job = jobOf(env);
    // Everything before the receipt (the first message needing the model) was reviewed once.
    expect(job.stats.reviewed).toBe(4);
    expect(job.pending.map((p) => p.candidate.id).sort()).toEqual([ids.friend.id, ids.conversation.id, ids.trusted.id].sort());

    env.MAX_MODEL_CALLS_PER_RUN = "16";
    await workUntilIdle(env, fake);
    expect(jobOf(env).stats.reviewed).toBe(7);
    expect(jobOf(env).pending.map((p) => p.candidate.id)).toContain(ids.receipt.id);
  });

  it("does not treat a spammer you replied to as a fact, in a new thread or the same one", async () => {
    const original = spamEmail({ from: "spammer@scam.example", subject: "Offer", threadId: "TS", daysAgo: 30 });
    const newThread = spamEmail({ from: "spammer@scam.example", subject: "Another offer" });
    const sameThread = spamEmail({ from: "spammer@scam.example", subject: "Re: Offer", threadId: "TS" });
    const fake = new FakeJmap({ emails: [original, sentReply("spammer@scam.example", "TS", 20), newThread, sameThread] });
    const env = testEnv({ AI: new FakeAi(), RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token" });
    const runs = await workUntilIdle(env, fake);

    expect(runs.flatMap((r) => r.suspects)).toEqual([]);
    expect(runs.some((r) => r.rescue)).toBe(false);
    // All three went to the model, which was told you have only ever replied.
    const sent = runs.flatMap((r) => r.modelItems.map((m) => m.item.message));
    expect(sent).toHaveLength(3);
    expect(sent.every((m) => m.replied_before)).toBe(true);
  });

  it("applies per-tier thresholds and REPORT_TIERS to model verdicts, never to facts", async () => {
    const promo = () => new FakeAi((m) => (m.subject.includes("receipt") ? { choice: "promotional", probabilities: dist("promotional", 0.9) } : { choice: "spam", probabilities: dist("spam", 0.9) }));
    const found = async (extra: Record<string, string>) => {
      const { fake, env, ids } = world();
      Object.assign(env, { AI: promo(), ...extra });
      const runs = await workUntilIdle(env, fake);
      return { suspects: runs.flatMap((r) => r.suspects), ids };
    };
    let r = await found({ TIER_THRESHOLDS: "promotional:0.99" });
    expect(r.suspects.map((s) => s.candidate.id)).not.toContain(r.ids.receipt.id);
    r = await found({ REPORT_TIERS: "important" });
    expect(r.suspects.map((s) => s.candidate.id)).not.toContain(r.ids.receipt.id);
    expect(r.suspects).toHaveLength(3);
    r = await found({});
    expect(r.suspects.find((s) => s.candidate.id === r.ids.receipt.id)?.tier).toBe("promotional");
  });

  it("records a failed run in the job, for the digest, and rethrows", async () => {
    const { fake, env } = world();
    await workUntilIdle(env, fake);
    env.FASTMAIL_TOKEN = "revoked";
    await expect(run(env, at(START, 15), { fetchImpl: fake.fetch, ...quiet })).rejects.toThrow(/HTTP 401/);
    expect(jobOf(env).stats.failures.map((f) => f.message).join(" ")).toMatch(/HTTP 401/);
    // Progress made before the failure is kept.
    expect(jobOf(env).pending).toHaveLength(4);
  });

  it("stays within the Workers Free subrequest budget on every run", async () => {
    const { fake, env } = world();
    const runs = await workUntilIdle(env, fake);
    expect(Math.max(...runs.map((r) => r.subrequests))).toBeLessThanOrEqual(45);
  });
});

describe("CPU", () => {
  it("never loads timezone data in UTC (its first use costs about 7 ms of CPU)", async () => {
    const spy = vi.spyOn(Intl, "DateTimeFormat");
    try {
      const { fake, env } = world();
      const notifier = new Recorder();
      for (let m = 0; m < 6; m++) await run(env, at(START, 15 * m), { fetchImpl: fake.fetch, notifier, ...quiet });
      // Includes a correspondent fact (which shows a date) and the digest itself.
      await run(env, at(SLOT, 7 * 1440), { fetchImpl: fake.fetch, notifier, ...quiet });
      expect(notifier.sent[0]!.text).toContain("last on Sat, 24 Oct 2026");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("works out the next digest time once, and again only when the schedule changes", async () => {
    const { fake, env } = world();
    await run(env, START, { fetchImpl: fake.fetch, ...quiet });
    expect(jobOf(env).nextDigestAt).toBe(SLOT.toISOString());
    env.DIGEST_DAYS = "tue";
    env.DIGEST_HOUR = "7";
    await run(env, at(START, 15), { fetchImpl: fake.fetch, ...quiet });
    expect(jobOf(env).nextDigestAt).toBe("2026-11-24T07:00:00.000Z");
  });
});

describe("rescue", () => {
  it("moves fact-based finds only (RESCUE_BASIS=deterministic), as each slice is reviewed", async () => {
    const { fake, env, ids } = world();
    Object.assign(env, { RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token" });
    const runs = await workUntilIdle(env, fake);
    expect(runs.flatMap((r) => r.rescue?.moved ?? []).sort()).toEqual([ids.friend.id, ids.conversation.id, ids.trusted.id].sort());
    expect(ids.receipt.mailboxIds).toEqual({ "mb-junk": true });
    expect(ids.friend.mailboxIds).toEqual({ "mb-rescued": true });
    // Only the write token wrote, and only Email/set updates.
    const writes = fake.calls.filter((c) => c.name === "Email/set");
    expect(writes.every((w) => w.token === "write-token" && !("destroy" in w.args) && !("create" in w.args))).toBe(true);

    const notifier = new Recorder();
    await digest(env, SLOT, { fetchImpl: fake.fetch, notifier, ...quiet });
    expect(notifier.sent[0]!.text).toContain("→ moved to Rescued");
    // Moved finds are listed even though they are no longer in Spam.
    expect(notifier.sent[0]!.subject).toMatch(/^\[fastspam\] 4 important/);
  });

  it("RESCUE_BASIS=all lets model verdicts move mail too", async () => {
    const { fake, env, ids } = world();
    Object.assign(env, { RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token", RESCUE_BASIS: "all" });
    const runs = await workUntilIdle(env, fake);
    expect(runs.flatMap((r) => r.rescue?.moved ?? [])).toContain(ids.receipt.id);
  });

  it("caps moves per digest period, across runs", async () => {
    const spam = Array.from({ length: 5 }, (_, i) => spamEmail({ from: `p${i}@trusted.example`, subject: `s${i}`, daysAgo: 5 - i }));
    const fake = new FakeJmap({ emails: [...spam] });
    const env = testEnv({ AI: new FakeAi(), TRUSTED_SENDERS: "trusted.example", RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token", SPAM_SLICE: "2", MAX_RESCUES_PER_DIGEST: "3" });
    const runs = await workUntilIdle(env, fake);
    expect(runs.flatMap((r) => r.rescue?.moved ?? [])).toHaveLength(3);
    expect(jobOf(env).rescueSkipped.map((s) => s.reason)).toEqual(["MAX_RESCUES_PER_DIGEST reached", "MAX_RESCUES_PER_DIGEST reached"]);
  });

  it("refuses to rescue with a write token for a different account", async () => {
    const { ids } = world();
    const fake = new FakeJmap({
      emails: [ids.friend, sentEmail("friend@mail.example", 30)],
      tokens: { "read-token": { accountId: "acc1", readOnly: true }, "write-token": { accountId: "other", readOnly: false } },
    });
    const env = testEnv({ AI: new FakeAi(), RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token" });
    const runs = await workUntilIdle(env, fake);
    expect(runs.some((r) => r.rescue)).toBe(false);
    expect(jobOf(env).stats.failures.map((f) => f.message).join(" ")).toMatch(/different account/);
    expect(fake.calls.filter((c) => c.name === "Email/set")).toHaveLength(0);
  });
});

describe("the digest", () => {
  it("goes out on the first run after the digest time, then work resumes", async () => {
    const { fake, env } = world();
    const notifier = new Recorder();
    const go = (d: Date) => run(env, d, { fetchImpl: fake.fetch, notifier, ...quiet });

    // A new job never sends straight away, even at the digest time.
    expect((await go(SLOT)).kind).toBe("work");
    expect(notifier.sent).toHaveLength(0);
    for (let m = 15; m < 60; m += 15) expect((await go(at(SLOT, m))).kind).toBe("work");

    // A week later the 20:00 run is missed; 20:15 catches up.
    const next = at(SLOT, 7 * 1440 + 15);
    const r = await go(next);
    expect(r.kind).toBe("digest");
    expect(notifier.sent[0]!.subject).toBe(`[fastspam] 4 important in 7 spam (2026-11-30)`);
    expect(notifier.sent[0]!.text).toContain("Reviewed 7 messages in Spam since Mon, 23 Nov 2026.");

    // The period starts again.
    const job = jobOf(env);
    expect(job.pending).toEqual([]);
    expect(job.stats.reviewed).toBe(0);
    expect(job.lastDigestAt).toBe(next.toISOString());
    expect((await go(at(next, 15))).kind).toBe("work");
  });

  it("keeps everything when the send fails, and retries at most hourly", async () => {
    const { fake, env } = world();
    await workUntilIdle(env, fake);
    const notifier = new Recorder();
    notifier.fail = true;
    const go = (d: Date) => run(env, d, { fetchImpl: fake.fetch, notifier, ...quiet });
    await expect(go(SLOT)).rejects.toThrow("smtp down");
    expect(jobOf(env).pending).toHaveLength(4);
    expect(jobOf(env).digestFailedAt).toBe(SLOT.toISOString());

    notifier.fail = false;
    expect((await go(at(SLOT, 15))).kind).toBe("work");
    expect((await go(at(SLOT, 60))).kind).toBe("digest");
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]!.text).toMatch(/the last digest could not be sent: smtp down/);
  });

  it("leaves out finds that have already left Spam", async () => {
    const { fake, env, ids } = world();
    await workUntilIdle(env, fake);
    ids.trusted.mailboxIds = { "mb-inbox": true };
    const notifier = new Recorder();
    await digest(env, SLOT, { fetchImpl: fake.fetch, notifier, ...quiet });
    expect(notifier.sent[0]!.subject).toMatch(/^\[fastspam\] 3 important/);
    expect(notifier.sent[0]!.text).toContain("1 earlier find has already left Spam and isn't listed.");
  });

  it("shows progress while Sent is indexed and Spam is worked through", async () => {
    const spam = Array.from({ length: 10 }, (_, i) => spamEmail({ from: `s${i}@spam.example`, subject: `o${i}`, daysAgo: 20 - i }));
    const fake = new FakeJmap({ emails: [...spam, ...Array.from({ length: 15 }, (_, i) => sentEmail(`p${i}@mail.example`, 30 + i))] });
    const env = testEnv({ AI: new FakeAi(), SENT_PAGE: "10", SPAM_SLICE: "4" });
    const notifier = new Recorder();
    const show = async () => (await digest(env, SLOT, { fetchImpl: fake.fetch, notifier, readOnly: true, ...quiet })).message!.text;

    await work(env, START, { fetchImpl: fake.fetch, ...quiet });
    expect(await show()).toContain("Still indexing your Sent mail (10 of 15 messages). Spam review starts when that's done.");
    await work(env, START, { fetchImpl: fake.fetch, ...quiet });
    await work(env, START, { fetchImpl: fake.fetch, ...quiet });
    expect(await show()).toMatch(/Still working through older Spam: reviewed up to .+, about 6 to go\./);
    expect(notifier.sent).toHaveLength(0);
  });

  it("notes when the scanning token could write", async () => {
    const { fake, env } = world();
    env.FASTMAIL_TOKEN = "write-token";
    await workUntilIdle(env, fake);
    const r = await digest(env, SLOT, { fetchImpl: fake.fetch, notifier: new Recorder(), ...quiet });
    expect(r.stats.notes.join(" ")).toMatch(/only needs a Read-only access token/);
  });

  it("reports model failures rather than failing the run", async () => {
    const { fake, env } = world();
    env.AI_MODEL = "google/gemini-decision-1";
    // Without a gateway the model can't run, so the slice stops at the first message needing it.
    await work(env, START, { fetchImpl: fake.fetch, ...quiet });
    const r = await work(env, START, { fetchImpl: fake.fetch, ...quiet });
    expect(r.suspects.map((s) => s.basis).sort()).toEqual(["correspondent", "thread", "trusted"]);
    const notifier = new Recorder();
    await digest(env, SLOT, { fetchImpl: fake.fetch, notifier, ...quiet });
    expect(notifier.sent[0]!.text).toMatch(/! google\/gemini-decision-1 runs through AI Gateway/);
  });

  it("DRY_RUN prints the digest instead of sending it; preview mode returns it", async () => {
    const { fake, env } = world();
    await workUntilIdle(env, fake);
    env.DRY_RUN = "true";
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    try {
      await digest(env, SLOT, { fetchImpl: fake.fetch, ...quiet });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("[fastspam] 4 important in 7 spam");

    const { fake: f2, env: e2 } = world();
    await workUntilIdle(e2, f2);
    const notifier = new Recorder();
    const preview = await digest(e2, SLOT, { fetchImpl: f2.fetch, notifier, readOnly: true, ...quiet });
    expect(preview.message?.subject).toMatch(/4 important in 7 spam/);
    expect(notifier.sent).toHaveLength(0);
    expect(jobOf(e2).pending).toHaveLength(4); // preview clears nothing
  });

  it("delivers through the Fastmail notifier with the write token only", async () => {
    const { fake, env } = world();
    Object.assign(env, { NOTIFIER: "fastmail", FASTMAIL_WRITE_TOKEN: "write-token" });
    await workUntilIdle(env, fake);
    await digest(env, SLOT, { fetchImpl: fake.fetch, ...quiet });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({ mailboxIds: { "mb-inbox": true } });
    expect(fake.calls.filter((c) => c.name === "Email/set").every((c) => c.token === "write-token")).toBe(true);
  });

  it("explains a missing write token for the Fastmail notifier", async () => {
    const { fake, env } = world();
    env.NOTIFIER = "fastmail";
    await expect(digest(env, SLOT, { fetchImpl: fake.fetch, ...quiet })).rejects.toThrow(/FASTMAIL_WRITE_TOKEN/);
  });
});

describe("alerts about repeated failures", () => {
  /** Index Sent first, then make every model call fail. */
  async function failing() {
    const w = world();
    const notifier = new Recorder();
    await work(w.env, START, { fetchImpl: w.fake.fetch, ...quiet }); // indexes Sent; Spam is next
    (w.ai as FakeAi).failWith = new Error("7003: User Input Error");
    const go = (minutes: number) => run(w.env, at(START, minutes), { fetchImpl: w.fake.fetch, notifier, ...quiet });
    return { ...w, notifier, go };
  }

  it("counts a repeated failure and when it last happened", async () => {
    const { env, go } = await failing();
    await go(15);
    await go(30);
    const f = jobOf(env).stats.failures;
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ count: 2, last: at(START, 30).toISOString() });
    expect(f[0]!.message).toMatch(/7003/);
  });

  it("alerts after three failed runs in a row, then at most daily", async () => {
    const { go, notifier } = await failing();
    expect((await go(15)).kind).toBe("work");
    expect((await go(30)).kind).toBe("work");
    expect(notifier.sent).toHaveLength(0);
    expect((await go(45)).kind).toBe("work");
    const alert = await go(60);
    expect(alert).toMatchObject({ kind: "alert", sent: true, runs: 3 });
    expect(notifier.sent[0]!.subject).toMatch(/^\[fastspam\] problem: .*7003/);
    expect(notifier.sent[0]!.text).toMatch(/3 runs in a row/);
    expect(notifier.sent[0]!.text).toMatch(/7003: User Input Error .*\(3 times, last Mon 23 Nov, 12:45 UTC\)/);
    // Still failing, but no second alert the same day.
    for (const m of [75, 90, 105]) expect((await go(m)).kind).toBe("work");
    expect(notifier.sent).toHaveLength(1);
  });

  it("doesn't alert about a one-off, and a clean run starts the count again", async () => {
    const { env, ai, go, notifier } = await failing();
    await go(15);
    await go(30);
    (ai as FakeAi).failWith = undefined;
    await go(45);
    expect(jobOf(env).failStreak).toBeUndefined();
    (ai as FakeAi).failWith = new Error("7003: User Input Error");
    await go(60);
    await go(75);
    expect((await go(90)).kind).toBe("work");
    expect(notifier.sent).toHaveLength(0);
  });

  it("a broken notifier can't take over every run", async () => {
    const { go, notifier, env } = await failing();
    for (const m of [15, 30, 45]) await go(m);
    notifier.fail = true;
    await expect(go(60)).rejects.toThrow(/smtp down/);
    expect(jobOf(env).stats.failures.map((f) => f.message).join(" ")).toMatch(/an alert could not be sent/);
    expect((await go(75)).kind).toBe("work");
  });
});

describe("learning from what you do in Spam", () => {
  const scored = (score: number, from: string, subject: string, extra: Record<string, unknown> = {}) =>
    spamEmail({ from, subject, headers: { "x-spam-score": [String(score)], "authentication-results": ["mx.messagingengine.com; dmarc=pass"] }, ...extra });
  const indexOf = (env: Env) => JSON.parse((env.FASTSPAM_STATE as unknown as MemoryKV).store.get("index")!);

  function setup(over: Record<string, unknown> = {}) {
    const handMoved = scored(0.7, "pitch@cold.example", "We are live", { daysAgo: 40, keywords: { $seen: true } });
    const forgedMove = spamEmail({ from: "ceo@bank.example", subject: "Wire", daysAgo: 30, headers: { "x-spam-score": ["1"], "authentication-results": ["mx.messagingengine.com; dmarc=fail"] } });
    const filed = scored(12, "promo@shop.example", "Your receipt");
    const fake = new FakeJmap({ emails: [handMoved, forgedMove, filed, sentEmail("friend@mail.example", 30)] });
    const ai = new FakeAi((m) => (m.subject.includes("receipt") ? { choice: "transactional", probabilities: dist("transactional", 0.9) } : { choice: "spam", probabilities: dist("spam", 0.9) }));
    const env = testEnv({ AI: ai, ...over });
    return { fake, ai, env, handMoved, forgedMove, filed };
  }

  it("never reports what you moved to Spam, and learns its sender (not a forged one)", async () => {
    const { fake, ai, env, handMoved } = setup();
    const reports = await workUntilIdle(env, fake);
    expect(reports.flatMap((r) => r.suspects).map((s) => s.candidate.subject)).toEqual(["Your receipt"]);
    // The two low scorers never reached the model.
    expect(ai.calls).toHaveLength(1);
    expect(Object.keys(indexOf(env).movedToSpam)).toEqual(["pitch@cold.example"]);

    // Their next message is filed by the filter, and isn't reported either.
    fake.emails.push(scored(9, "pitch@cold.example", "Your receipt is waiting", { daysAgo: 0.5 }));
    const later = await work(env, at(START, 15), { fetchImpl: fake.fetch, ...quiet });
    expect(later.reviewed).toHaveLength(1);
    expect(later.suspects).toHaveLength(0);
    expect(ai.calls).toHaveLength(1);
    void handMoved;
  });

  it("forgets a sender whose recent mail you moved back out, and keeps one whose mail aged out", async () => {
    const { fake, env, handMoved } = setup();
    const recent = scored(1, "oops@friendly.example", "Hi", { daysAgo: 3 });
    fake.emails.push(recent);
    await workUntilIdle(env, fake);
    expect(Object.keys(indexOf(env).movedToSpam).sort()).toEqual(["oops@friendly.example", "pitch@cold.example"]);

    recent.mailboxIds = { "mb-inbox": true }; // you moved it back
    fake.emails.splice(fake.emails.indexOf(handMoved), 1); // purged with old Spam
    for (const m of [60, 420, 435]) await work(env, at(START, m), { fetchImpl: fake.fetch, ...quiet });
    expect(Object.keys(indexOf(env).movedToSpam)).toEqual(["pitch@cold.example"]);
  });

  it("with SPAM_SKIP_READ, drops read Spam, unless Fastmail marks all spam read", async () => {
    const { fake, ai, env } = setup({ SPAM_SKIP_READ: "true" });
    fake.emails.push(scored(12, "news@letters.example", "Your receipt, read", { keywords: { $seen: true } }));
    const reports = await workUntilIdle(env, fake);
    expect(reports.flatMap((r) => r.suspects).map((s) => s.candidate.subject)).toEqual(["Your receipt"]);
    expect(jobOf(env).spam.autoRead).toBeFalsy(); // too few messages to tell, so the rule applies
    void ai;

    const auto = setup({ SPAM_SKIP_READ: "true" });
    for (let i = 0; i < 25; i++) auto.fake.emails.push(scored(12, `x${i}@spam.example`, `Offer ${i}`, { keywords: { $seen: true } }));
    auto.fake.emails.push(scored(12, "news@letters.example", "Your receipt, read", { keywords: { $seen: true } }));
    const r2 = await workUntilIdle(auto.env, auto.fake);
    expect(jobOf(auto.env).spam.autoRead).toBe(true);
    expect(jobOf(auto.env).stats.notes.join(" ")).toMatch(/SPAM_SKIP_READ is being ignored/);
    expect(r2.flatMap((r) => r.suspects).map((s) => s.candidate.subject).sort()).toEqual(["Your receipt", "Your receipt, read"]);
  });

  it("with SPAM_SKIP_READ, leaves out of the digest a find you've since read", async () => {
    const { fake, env, filed } = setup({ SPAM_SKIP_READ: "true" });
    await workUntilIdle(env, fake);
    filed.keywords = { $seen: true };
    const notifier = new Recorder();
    const d = await digest(env, SLOT, { fetchImpl: fake.fetch, notifier, ...quiet });
    expect(d.listed).toBe(0);
    expect(d.message!.text).toContain("1 earlier find you'd read and left in Spam isn't listed.");
  });
});
