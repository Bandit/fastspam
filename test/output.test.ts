import { describe, expect, it } from "vitest";
import { PostmarkNotifier } from "../src/notify/notifier.ts";
import { makeLinker, renderDigest, type RunStats } from "../src/lib/digest.ts";
import type { Candidate, Suspect } from "../src/types.ts";
import { jsonResponse } from "./helpers.ts";

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id,
  threadId: `T${id}`,
  fromName: "Shop",
  fromEmail: "orders@shop.example",
  subject: "Your order",
  receivedAt: "2026-11-20T09:00:00Z",
  preview: "",
  spamScore: null,
  spamHeaders: {},
  auth: {},
  ...over,
});

const stats = (over: Partial<RunStats> = {}): RunStats => ({
  reviewed: 10,
  since: new Date("2026-11-16T20:00:00Z"),
  droppedByRule: 1,
  settledByFact: 1,
  sentToModel: 8,
  modelCalls: 1,
  model: "@cf/cloudflare/clef",
  failures: [],
  notes: [],
  ...over,
});

const base = { now: new Date("2026-11-23T20:00:00Z"), timezone: "UTC", sendWhenEmpty: true, link: () => undefined };

describe("digest", () => {
  it("lists facts before model judgements, and says which is which", () => {
    const suspects: Suspect[] = [
      { candidate: cand("1", { subject: "Model one" }), basis: "model", tier: "important", detail: "", verdict: { notSpam: 0.82, top: "transactional", category: "transactional", tier: "important" } },
      { candidate: cand("3", { subject: "Yes-no one" }), basis: "model", tier: "general", detail: "", verdict: { notSpam: 0.7, tier: "general" } },
      { candidate: cand("4", { subject: "Big sale" }), basis: "model", tier: "promotional", detail: "", verdict: { notSpam: 0.9, category: "promotional", tier: "promotional" } },
      { candidate: cand("2", { subject: "Fact one" }), basis: "correspondent", tier: "important", detail: "You have started conversations with this address (last on Fri, 3 Oct 2026)" },
    ];
    const m = renderDigest({ ...base, suspects, stats: stats() })!;
    expect(m.subject).toBe("[fastspam] 2 important, 1 worth a look, 1 promotion in 10 spam (2026-11-23)");
    // Tiers in order, facts before the model within a tier.
    const at = (x: string) => m.text.indexOf(x);
    expect(at("🔴 IMPORTANT (2)")).toBeLessThan(at("🟠 WORTH A LOOK (1)"));
    expect(at("🟠 WORTH A LOOK (1)")).toBeLessThan(at("🔵 PROMOTIONS (1)"));
    expect(at("Fact one")).toBeLessThan(at("Model one"));
    expect(m.text).toContain("transactional · 82% not spam (model)");
    expect(m.text).toContain("70% likely legitimate (model)");
    expect(m.text).toContain("You have started conversations with this address");
    // Promotions are one line each.
    expect(m.text).toContain("• Big sale · orders@shop.example\n");
  });
  it("sanitises untrusted text again on the way out", () => {
    const m = renderDigest({ ...base, suspects: [{ candidate: cand("1", { subject: "Hi\nBcc: x‮" }), basis: "thread", tier: "important", detail: "d" }], stats: stats() })!;
    expect(m.text).toContain("• Hi Bcc: x\n");
  });
  it("sends an all-clear by default and nothing when SEND_WHEN_EMPTY=false", () => {
    expect(renderDigest({ ...base, suspects: [], stats: stats() })?.subject).toMatch(/nothing to rescue/);
    expect(renderDigest({ ...base, sendWhenEmpty: false, suspects: [], stats: stats() })).toBeNull();
  });
  it("still sends when there were problems, even if empty", () => {
    const m = renderDigest({ ...base, sendWhenEmpty: false, suspects: [], stats: stats({ failures: [{ message: "boom", count: 1 }] }) });
    expect(m?.subject).toMatch(/with problems/);
    expect(m?.text).toContain("! boom");
  });
  it("shows moved and not-moved messages when rescuing", () => {
    const m = renderDigest({
      ...base,
      suspects: [{ candidate: cand("1"), basis: "thread", tier: "important", detail: "d" }],
      rescue: { moved: ["1"], skipped: [{ id: "9", reason: "no longer in Spam" }] },
      rescueMailboxName: "Rescued",
      stats: stats(),
    })!;
    expect(m.text).toContain("→ moved to Rescued");
    expect(m.text).toContain("NOT MOVED (1)");
  });
  it("builds links from code-held values only, URL-encoded", () => {
    const link = makeLinker("https://app.example/mail/{mailboxName}/{threadId}.{id}?u={accountId}", { accountId: "a 1", mailboxId: "mb", mailboxName: "Spam" });
    expect(link(cand("M/1"))).toBe("https://app.example/mail/Spam/TM%2F1.M%2F1?u=a%201");
    expect(makeLinker("", { accountId: "", mailboxId: "", mailboxName: "" })(cand("1"))).toBeUndefined();
  });
});

describe("Postmark notifier", () => {
  it("posts the digest as text and reports Postmark errors without headers", async () => {
    const sent: RequestInit[] = [];
    const ok = new PostmarkNotifier("tok", "from@sender.example", ["a@owner.example", "b@owner.example"], "outbound", async (_u, init) => {
      sent.push(init!);
      return jsonResponse({});
    });
    await ok.send({ subject: "S", text: "T" });
    expect(JSON.parse(String(sent[0]!.body))).toMatchObject({ From: "from@sender.example", To: "a@owner.example,b@owner.example", Subject: "S", TextBody: "T", Tag: "fastspam" });

    const bad = new PostmarkNotifier("tok", "f@sender.example", ["t@owner.example"], "outbound", async () => jsonResponse({ ErrorCode: 300, Message: "Invalid email" }, 422));
    await expect(bad.send({ subject: "S", text: "T" })).rejects.toThrow(/ErrorCode 300 Invalid email/);
  });
});
