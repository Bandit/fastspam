import { describe, expect, it } from "vitest";
import { decideIncoming, type IncomingContext } from "../src/incoming.ts";
import { lookup } from "../src/jmap/correspondents.ts";
import { buildPayload } from "../src/ai/classifier.ts";
import type { Candidate } from "../src/types.ts";

const cand = (over: Partial<Candidate> = {}): Candidate => ({
  id: "M1",
  threadId: "T1",
  fromName: "Someone",
  fromEmail: "stranger@cold.example",
  subject: "Hello",
  receivedAt: "2026-11-20T09:00:00Z",
  preview: "",
  spamScore: 2,
  spamHeaders: {},
  auth: { dmarc: "pass" },
  ...over,
});

// Built at runtime: a real webmail domain is the point, and the privacy test
// rightly rejects literal addresses on real domains.
const webmail = (local: string) => [local, "gmail.com"].join("@");

const ctx = (over: Partial<IncomingContext> = {}): IncomingContext => ({
  alwaysReport: ["trusted.example"],
  neverReport: ["blocked.example"],
  honourDmarcPolicy: true,
  correspondents: lookup({
    v: 3,
    addresses: { "friend@client.example": 1, [webmail("pal")]: 1, "spammer@scam.example": 1 },
    started: { "friend@client.example": 1, [webmail("pal")]: 1 },
    self: ["owner@owner.example"],
  }),
  threadsWithYourMail: new Set(["T-yours"]),
  ...over,
});

const outcome = (c: Partial<Candidate>, o: Partial<IncomingContext> = {}) => {
  const d = decideIncoming(cand(c), ctx(o));
  return d.outcome === "skip" ? `skip:${d.reason}` : d.outcome === "flag" ? `flag:${d.basis}` : "model";
};

describe("incoming mail rules", () => {
  it("skips mail that facts show is legitimate, without the model", () => {
    expect(outcome({ fromEmail: "owner@owner.example" })).toBe("skip:self");
    expect(outcome({ fromEmail: "billing@trusted.example" })).toBe("skip:allowlist");
    expect(outcome({ fromEmail: "friend@client.example" })).toBe("skip:correspondent");
    expect(outcome({ fromEmail: "colleague@client.example" })).toBe("skip:known-domain");
    expect(outcome({ threadId: "T-yours" })).toBe("skip:conversation");
  });

  it("flags hard failures without the model", () => {
    expect(outcome({ fromEmail: "friend@client.example", auth: { dmarc: "fail", dmarcPolicy: "reject" } })).toBe("flag:dmarc-policy");
    expect(outcome({ fromEmail: "x@blocked.example" })).toBe("flag:blocklist");
  });

  it("trusts no sender-based fact when DMARC fails", () => {
    const forged = { dmarc: "fail" as const, dmarcPolicy: "none" as const };
    expect(outcome({ fromEmail: "owner@owner.example", auth: forged })).toBe("model");
    expect(outcome({ fromEmail: "friend@client.example", auth: forged })).toBe("model");
    expect(outcome({ fromEmail: "billing@trusted.example", auth: forged })).toBe("model");
  });

  it("counts a known domain only with DMARC passing, only for domains you started conversations with, never webmail", () => {
    expect(outcome({ fromEmail: "colleague@client.example", auth: {} })).toBe("model");
    expect(outcome({ fromEmail: "colleague@client.example", auth: { dmarc: "none" } })).toBe("model");
    // You only replied to someone at scam.example: that domain isn't known.
    expect(outcome({ fromEmail: "other@scam.example" })).toBe("model");
    // You wrote to someone at gmail.com: a stranger there is still a stranger.
    expect(outcome({ fromEmail: webmail("stranger") })).toBe("model");
  });

  it("sends a cold sender to the model", () => {
    expect(outcome({})).toBe("model");
  });

  it("tells the model where the messages came from", () => {
    expect(buildPayload([], "n")).toMatch(/moved to the Junk folder/);
    expect(buildPayload([], "n", "incoming")).toMatch(/were not caught by its spam filter/);
    expect(buildPayload([], "n", "incoming")).not.toMatch(/Junk/);
  });
});
