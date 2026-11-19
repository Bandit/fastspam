import { describe, expect, it } from "vitest";
import { run } from "../src/pipeline.ts";
import type { Message, Notifier } from "../src/notify/notifier.ts";
import { dist, FakeAi, FakeJmap, MemoryKV, sentEmail, sentReply, spamEmail, testEnv } from "./helpers.ts";

const NOW = new Date("2026-11-23T20:00:00Z");

class Recorder implements Notifier {
  readonly name = "recorder";
  sent: Message[] = [];
  fail = false;
  async send(m: Message) {
    if (this.fail) throw new Error("smtp down");
    this.sent.push(m);
  }
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
  const env = testEnv({ AI: ai, ALWAYS_REPORT: "trusted.example", NEVER_REPORT: "blocked.example" });
  return { fake, ai, env, ids: { friend, conversation, trusted, blocked, receipt, junk, forged } };
}

describe("pipeline", () => {
  it("settles facts deterministically and asks the model only about the rest", async () => {
    const { fake, ai, env, ids } = world();
    const notifier = new Recorder();
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier, log: () => {} });

    const byBasis = Object.fromEntries(report.suspects.map((s) => [s.candidate.id, s.basis]));
    expect(byBasis).toEqual({
      [ids.friend.id]: "correspondent",
      [ids.conversation.id]: "thread",
      [ids.trusted.id]: "allowlist",
      [ids.receipt.id]: "model",
    });
    // One model call, about exactly the three messages no fact could settle.
    expect(ai.calls).toHaveLength(1);
    expect(Object.keys(ai.calls[0]!.input.questions as object)).toHaveLength(3);
    expect(report.stats).toMatchObject({ fresh: 7, droppedByRule: 1, settledByFact: 3, sentToModel: 3 });
    expect(notifier.sent[0]!.subject).toBe("[fastspam] 4 important in 7 spam (2026-11-23)");
    expect(report.suspects.every((s) => s.tier === "important")).toBe(true);
    // The scanning token never wrote anything.
    expect(fake.calls.filter((c) => c.name === "Email/set")).toHaveLength(0);
  });

  it("does not treat a spammer you replied to as a fact, in a new thread or the same one", async () => {
    const original = spamEmail({ from: "spammer@scam.example", subject: "Offer", threadId: "TS", daysAgo: 30 });
    const newThread = spamEmail({ from: "spammer@scam.example", subject: "Another offer" });
    const sameThread = spamEmail({ from: "spammer@scam.example", subject: "Re: Offer", threadId: "TS" });
    const fake = new FakeJmap({ emails: [original, sentReply("spammer@scam.example", "TS", 20), newThread, sameThread] });
    const ai = new FakeAi(() => ({ choice: "spam", probabilities: dist("spam", 0.9) }));
    const env = testEnv({ AI: ai, RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token" });
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });

    expect(report.stats.settledByFact).toBe(0);
    expect(report.suspects).toEqual([]);
    expect(report.rescue).toBeUndefined();
    // Both went to the model, which was told you have only ever replied.
    const sent = report.modelItems.map((m) => m.item.message);
    expect(sent).toHaveLength(2);
    expect(sent.every((m) => m.replied_before)).toBe(true);
  });

  it("applies per-tier thresholds and REPORT_TIERS to model verdicts, never to facts", async () => {
    const { fake, env, ids } = world();
    env.AI = new FakeAi((m) =>
      m.subject.includes("receipt") ? { choice: "promotional", probabilities: dist("promotional", 0.9) } : { choice: "spam", probabilities: dist("spam", 0.9) },
    );
    env.TIER_THRESHOLDS = "promotional:0.99";
    let report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), readOnly: true, log: () => {} });
    expect(report.suspects.map((s) => s.candidate.id)).not.toContain(ids.receipt.id);

    env.TIER_THRESHOLDS = "";
    env.REPORT_TIERS = "important";
    report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), readOnly: true, log: () => {} });
    expect(report.suspects.map((s) => s.candidate.id)).not.toContain(ids.receipt.id);
    expect(report.suspects).toHaveLength(3);

    env.REPORT_TIERS = "";
    report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), readOnly: true, log: () => {} });
    expect(report.suspects.find((s) => s.candidate.id === ids.receipt.id)?.tier).toBe("promotional");
  });

  it("persists state only after sending, and does not repeat itself", async () => {
    const { fake, ai, env } = world();
    const kv = env.FASTSPAM_STATE as unknown as MemoryKV;
    const notifier = new Recorder();
    await run(env, NOW, { fetchImpl: fake.fetch, notifier, log: () => {} });
    expect(Object.keys(JSON.parse(kv.store.get("reviewed")!))).toHaveLength(7);
    expect(kv.store.get("lastrun")).toBe(JSON.stringify(NOW.toISOString()));
    expect(JSON.parse(kv.store.get("correspondents")!).addresses).toHaveProperty(["friend@mail.example"]);

    const second = await run(env, new Date(NOW.getTime() + 7 * 86_400_000), { fetchImpl: fake.fetch, notifier, log: () => {} });
    expect(second.stats.fresh).toBe(0);
    expect(ai.calls).toHaveLength(1);
    expect(notifier.sent[1]!.subject).toMatch(/nothing to rescue/);
  });

  it("writes no state when the send fails, so next run reports the same messages", async () => {
    const { fake, env } = world();
    const kv = env.FASTSPAM_STATE as unknown as MemoryKV;
    const notifier = new Recorder();
    notifier.fail = true;
    await expect(run(env, NOW, { fetchImpl: fake.fetch, notifier, log: () => {} })).rejects.toThrow("smtp down");
    expect(kv.puts).toBe(0);
  });

  it("leaves unclassified messages unreviewed so they are retried", async () => {
    const { fake, env, ids } = world();
    env.MAX_MODEL_CALLS_PER_RUN = "0";
    const kv = env.FASTSPAM_STATE as unknown as MemoryKV;
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });
    expect(report.stats.unclassified).toBe(3);
    const reviewed = JSON.parse(kv.store.get("reviewed")!);
    expect(reviewed).not.toHaveProperty(ids.receipt.id);
    expect(reviewed).toHaveProperty(ids.friend.id);
  });

  it("DRY_RUN prints and persists nothing; preview mode returns the digest without sending", async () => {
    const { fake, env } = world();
    const kv = env.FASTSPAM_STATE as unknown as MemoryKV;
    env.DRY_RUN = "true";
    const logs: string[] = [];
    const orig = console.log;
    console.log = (m: string) => logs.push(m);
    try {
      await run(env, NOW, { fetchImpl: fake.fetch, log: () => {} });
    } finally {
      console.log = orig;
    }
    expect(logs.join("\n")).toContain("[fastspam] 4 important in 7 spam");
    expect(kv.puts).toBe(0);

    env.DRY_RUN = "false";
    const notifier = new Recorder();
    const preview = await run(env, NOW, { fetchImpl: fake.fetch, notifier, readOnly: true, log: () => {} });
    expect(preview.message?.subject).toMatch(/4 important in 7 spam/);
    expect(notifier.sent).toHaveLength(0);
    expect(kv.puts).toBe(0);
  });

  it("rescues fact-based suspects only (RESCUE_BASIS=deterministic)", async () => {
    const { fake, env, ids } = world();
    env.RESCUE_MAILBOX = "Rescued";
    env.FASTMAIL_WRITE_TOKEN = "write-token";
    const notifier = new Recorder();
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier, log: () => {} });
    expect(report.rescue?.moved.sort()).toEqual([ids.friend.id, ids.conversation.id, ids.trusted.id].sort());
    expect(ids.receipt.mailboxIds).toEqual({ "mb-junk": true });
    expect(ids.friend.mailboxIds).toEqual({ "mb-rescued": true });
    // Only the write token wrote, and only Email/set updates.
    const writes = fake.calls.filter((c) => c.name === "Email/set");
    expect(writes.every((w) => w.token === "write-token" && !("destroy" in w.args) && !("create" in w.args))).toBe(true);
    expect(notifier.sent[0]!.text).toContain("→ moved to Rescued");
  });

  it("RESCUE_BASIS=all lets model verdicts move mail too", async () => {
    const { fake, env, ids } = world();
    Object.assign(env, { RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token", RESCUE_BASIS: "all" });
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });
    expect(report.rescue?.moved).toContain(ids.receipt.id);
  });

  it("refuses to rescue with a write token for a different account", async () => {
    const { env, ids } = world();
    const fake = new FakeJmap({
      emails: [ids.friend, sentEmail("friend@mail.example", 30)],
      tokens: { "read-token": { accountId: "acc1", readOnly: true }, "write-token": { accountId: "other", readOnly: false } },
    });
    Object.assign(env, { RESCUE_MAILBOX: "Rescued", FASTMAIL_WRITE_TOKEN: "write-token" });
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });
    expect(report.rescue).toBeUndefined();
    expect(report.stats.failures.join(" ")).toMatch(/different account/);
    expect(fake.calls.filter((c) => c.name === "Email/set")).toHaveLength(0);
  });

  it("notes when the scanning token could write", async () => {
    const { fake, env } = world();
    env.FASTMAIL_TOKEN = "write-token";
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });
    expect(report.stats.notes.join(" ")).toMatch(/only needs a Read-only access token/);
  });

  it("delivers through the Fastmail notifier with the write token only", async () => {
    const { fake, env } = world();
    Object.assign(env, { NOTIFIER: "fastmail", FASTMAIL_WRITE_TOKEN: "write-token" });
    await run(env, NOW, { fetchImpl: fake.fetch, log: () => {} });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]).toMatchObject({ mailboxIds: { "mb-inbox": true } });
    expect(fake.calls.filter((c) => c.name === "Email/set").every((c) => c.token === "write-token")).toBe(true);
  });

  it("explains a missing write token for the Fastmail notifier", async () => {
    const { fake, env } = world();
    env.NOTIFIER = "fastmail";
    await expect(run(env, NOW, { fetchImpl: fake.fetch, log: () => {} })).rejects.toThrow(/FASTMAIL_WRITE_TOKEN/);
  });

  it("reports model failures in the digest rather than failing the run", async () => {
    const { fake, env } = world();
    env.AI_MODEL = "google/gemini-decision-1";
    const notifier = new Recorder();
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier, log: () => {} });
    expect(report.suspects.map((s) => s.basis).sort()).toEqual(["allowlist", "correspondent", "thread"]);
    expect(notifier.sent[0]!.text).toMatch(/! google\/gemini-decision-1 runs through AI Gateway/);
  });

  it("stays within the Workers Free subrequest budget on a typical run", async () => {
    const { fake, env } = world();
    const report = await run(env, NOW, { fetchImpl: fake.fetch, notifier: new Recorder(), log: () => {} });
    expect(report.subrequests).toBeLessThanOrEqual(45);
  });
});
