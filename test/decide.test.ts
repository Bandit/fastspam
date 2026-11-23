import { describe, expect, it } from "vitest";
import { decide, type DecideContext } from "../src/decide.ts";
import { lookup } from "../src/jmap/correspondents.ts";
import type { Candidate } from "../src/types.ts";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "M1",
  threadId: "T1",
  fromName: "",
  fromEmail: "sender@shop.example",
  subject: "s",
  receivedAt: "2026-11-20T00:00:00Z",
  preview: "",
  spamScore: null,
  spamHeaders: {},
  auth: {},
  ...over,
});

const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({
  spamSenders: [],
  trustedSenders: [],
  spamScoreSkipAbove: null,
  honourDmarcPolicy: true,
  correspondents: lookup({
    v: 3,
    addresses: { "friend@mail.example": Date.UTC(2026, 9, 3), "spammer@scam.example": Date.UTC(2026, 10, 1) },
    started: { "friend@mail.example": Date.UTC(2026, 9, 3) },
    self: ["owner@owner.example"],
  }),
  threadsWithRealMail: new Set(),
  formatDate: (ms) => new Date(ms).toISOString().slice(0, 10),
  ...over,
});

describe("decision ladder", () => {
  it("drops SPAM_SENDERS senders first, even if they are correspondents", () => {
    const d = decide(cand({ fromEmail: "friend@mail.example" }), ctx({ spamSenders: ["mail.example"] }));
    expect(d).toMatchObject({ outcome: "drop", reason: "spam-sender" });
  });
  it("drops DMARC failures when the sender's domain publishes quarantine or reject", () => {
    expect(decide(cand({ auth: { dmarc: "fail", dmarcPolicy: "reject" } }), ctx())).toMatchObject({ outcome: "drop", reason: "dmarc-policy" });
    expect(decide(cand({ auth: { dmarc: "fail", dmarcPolicy: "quarantine" } }), ctx())).toMatchObject({ outcome: "drop", reason: "dmarc-policy" });
    // Even from someone you started a conversation with: the From is forged.
    expect(decide(cand({ fromEmail: "friend@mail.example", auth: { dmarc: "fail", dmarcPolicy: "reject" } }), ctx()).outcome).toBe("drop");
  });
  it("leaves DMARC failures under p=none, or with the rule off, to the model", () => {
    expect(decide(cand({ auth: { dmarc: "fail", dmarcPolicy: "none" } }), ctx()).outcome).toBe("model");
    expect(decide(cand({ auth: { dmarc: "fail" } }), ctx()).outcome).toBe("model");
    expect(decide(cand({ auth: { dmarc: "fail", dmarcPolicy: "reject" } }), ctx({ honourDmarcPolicy: false })).outcome).toBe("model");
  });
  it("drops messages above SPAM_SCORE_SKIP_ABOVE only when configured", () => {
    expect(decide(cand({ spamScore: 12 }), ctx()).outcome).toBe("model");
    expect(decide(cand({ spamScore: 12 }), ctx({ spamScoreSkipAbove: 10 }))).toMatchObject({ outcome: "drop", reason: "spam-score" });
    expect(decide(cand({ spamScore: 9 }), ctx({ spamScoreSkipAbove: 10 })).outcome).toBe("model");
  });
  it("reports TRUSTED_SENDERS on the trusted basis", () => {
    expect(decide(cand(), ctx({ trustedSenders: ["*@shop.example"] }))).toMatchObject({ outcome: "report", basis: "trusted" });
  });
  it("does not treat an address you only ever replied to as a fact", () => {
    // People reply to spammers. Only starting a conversation counts.
    expect(decide(cand({ fromEmail: "spammer@scam.example" }), ctx()).outcome).toBe("model");
    expect(ctx().correspondents.repliedOnly("spammer@scam.example")).toBe(true);
    expect(ctx().correspondents.repliedOnly("friend@mail.example")).toBe(false);
  });
  it("reports addresses you started a conversation with, with the date", () => {
    const d = decide(cand({ fromEmail: "friend@mail.example" }), ctx());
    expect(d).toMatchObject({ outcome: "report", basis: "correspondent" });
    expect(d.outcome === "report" && d.detail).toContain("2026-10-03");
  });
  it("does not treat a shared domain as a correspondent", () => {
    expect(decide(cand({ fromEmail: "stranger@mail.example" }), ctx()).outcome).toBe("model");
  });
  it("never treats your own (often forged) address as a correspondent", () => {
    const c = ctx({ correspondents: lookup({ v: 3, addresses: { "owner@owner.example": 1 }, started: { "owner@owner.example": 1 }, self: ["owner@owner.example"] }) });
    expect(decide(cand({ fromEmail: "owner@owner.example" }), c).outcome).toBe("model");
  });
  it("skips sender-based facts when DMARC fails", () => {
    expect(decide(cand({ fromEmail: "friend@mail.example", auth: { dmarc: "fail" } }), ctx()).outcome).toBe("model");
    expect(decide(cand({ auth: { dmarc: "fail" } }), ctx({ trustedSenders: ["shop.example"] })).outcome).toBe("model");
  });
  it("reports messages in a thread that has real mail", () => {
    expect(decide(cand(), ctx({ threadsWithRealMail: new Set(["T1"]) }))).toMatchObject({ outcome: "report", basis: "thread" });
  });
  it("sends everything else to the model", () => {
    expect(decide(cand(), ctx())).toEqual({ outcome: "model" });
  });
});

describe("your own judgement", () => {
  const learned = lookup({
    v: 3,
    addresses: { "friend@mail.example": 1 },
    started: { "friend@mail.example": 1 },
    self: ["owner@owner.example"],
    movedToSpam: { "pitch@cold.example": { seen: 1, received: 1 }, "friend@mail.example": { seen: 1, received: 1 } },
  });

  it("drops Spam scoring below the filter's threshold: you put it there", () => {
    expect(decide(cand({ spamScore: 2.4 }), ctx({ spamFilterThreshold: 5 }))).toMatchObject({ outcome: "drop", reason: "moved-by-you" });
    // Even from someone you write to: moving it was the later, more specific judgement.
    expect(decide(cand({ fromEmail: "friend@mail.example", spamScore: 0 }), ctx({ spamFilterThreshold: 5 })).outcome).toBe("drop");
    expect(decide(cand({ spamScore: 5 }), ctx({ spamFilterThreshold: 5 })).outcome).toBe("model");
    expect(decide(cand({ spamScore: null }), ctx({ spamFilterThreshold: 5 })).outcome).toBe("model");
    expect(decide(cand({ spamScore: 2.4 }), ctx({ spamFilterThreshold: 0 })).outcome).toBe("model");
  });

  it("drops read Spam only with SPAM_SKIP_READ", () => {
    expect(decide(cand({ seen: true }), ctx({ skipRead: true }))).toMatchObject({ outcome: "drop", reason: "read" });
    expect(decide(cand({ seen: true }), ctx()).outcome).toBe("model");
    expect(decide(cand({ seen: false }), ctx({ skipRead: true })).outcome).toBe("model");
  });

  it("drops a sender you've moved to Spam before, unless a fact says otherwise", () => {
    expect(decide(cand({ fromEmail: "pitch@cold.example" }), ctx({ correspondents: learned }))).toMatchObject({ outcome: "drop", reason: "your-spam-sender" });
    // You started a conversation with them: still reported.
    expect(decide(cand({ fromEmail: "friend@mail.example" }), ctx({ correspondents: learned })).outcome).toBe("report");
    expect(decide(cand({ fromEmail: "pitch@cold.example" }), ctx({ correspondents: learned, trustedSenders: ["cold.example"] })).outcome).toBe("report");
    // A forged From proves nothing about the sender.
    expect(decide(cand({ fromEmail: "pitch@cold.example", auth: { dmarc: "fail" } }), ctx({ correspondents: learned })).outcome).toBe("model");
  });
});
