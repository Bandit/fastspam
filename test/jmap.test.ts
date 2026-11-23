import { describe, expect, it } from "vitest";
import { JmapAuthError, JmapClient, JmapMethodError } from "../src/jmap/client.ts";
import { listMailboxes, resolveMailbox } from "../src/jmap/mailboxes.ts";
import { emailProperties, fetchCandidates } from "../src/jmap/spam.ts";
import { threadsWithRealMail } from "../src/jmap/threads.ts";
import { applySent, emptyIndex, isReply, lookup, SENT_PROPERTIES, type SentRow } from "../src/jmap/correspondents.ts";
import { rescue } from "../src/jmap/rescue.ts";
import { isFreemail } from "../src/lib/freemail.ts";
import { appendDigest } from "../src/jmap/append.ts";
import { Budget } from "../src/lib/budget.ts";
import { FakeJmap, MAILBOXES, sentEmail, sentReply, spamEmail } from "./helpers.ts";

const client = (fake: FakeJmap, token = "read-token", budget?: Budget) =>
  new JmapClient({ sessionUrl: "https://jmap.test/session", token, fetchImpl: fake.fetch, budget });

describe("JMAP client", () => {
  it("reads limits and read-only status from the session", async () => {
    const s = await client(new FakeJmap({ maxCallsInRequest: 4, maxObjectsInGet: 7 })).session();
    expect(s).toMatchObject({ accountId: "acc1", accountReadOnly: true, maxCallsInRequest: 4, maxObjectsInGet: 7 });
  });
  it("explains a rejected token", async () => {
    await expect(client(new FakeJmap(), "wrong").session()).rejects.toThrow(JmapAuthError);
  });
  it("chunks gets by maxObjectsInGet and packs calls by maxCallsInRequest", async () => {
    const emails = Array.from({ length: 23 }, (_, i) => spamEmail({ from: `s${i}@x.example`, subject: `${i}` }));
    const fake = new FakeJmap({ emails, maxObjectsInGet: 2, maxCallsInRequest: 4 });
    const list = await client(fake).getMany("Email/get", emails.map((e) => e.id), ["id"]);
    expect(list).toHaveLength(23);
    expect(fake.requests).toHaveLength(3); // 12 calls of ≤2 ids, 4 per request
    expect(fake.requests.every((r) => r.calls.length <= 4)).toBe(true);
  });
  it("pages Email/query when the server caps limit", async () => {
    const emails = Array.from({ length: 10 }, (_, i) => spamEmail({ from: `s${i}@x.example`, subject: `${i}` }));
    const fake = new FakeJmap({ emails, queryLimitCap: 3 });
    const r = await client(fake).queryEmailIds({ inMailbox: "mb-junk" }, 8);
    expect(r.ids).toHaveLength(8);
    expect(r.total).toBe(10);
  });
  it("surfaces method-level errors", async () => {
    const c = client(new FakeJmap());
    const { accountId } = await c.session();
    await expect(c.request([["Email/set", { accountId, update: {} }, "s"]])).rejects.toThrow(JmapMethodError);
  });
  it("counts every HTTP request against the budget", async () => {
    const budget = new Budget(100);
    await listMailboxes(client(new FakeJmap(), "read-token", budget));
    expect(budget.used).toBe(2); // session + Mailbox/get
  });
});

describe("mailboxes", () => {
  it("resolves by role, then name, then explicit override", () => {
    expect(resolveMailbox(MAILBOXES, { label: "Spam", role: "junk", required: true })?.id).toBe("mb-junk");
    const noRoles = MAILBOXES.map((m) => ({ ...m, role: null }));
    expect(resolveMailbox(noRoles, { label: "Spam", role: "junk", names: /^(spam|junk)$/i, required: true })?.id).toBe("mb-junk");
    expect(resolveMailbox(MAILBOXES, { label: "Rescue", override: "rescued", required: true })?.id).toBe("mb-rescued");
    expect(resolveMailbox(MAILBOXES, { label: "Rescue", override: "mb-archive", required: true })?.id).toBe("mb-archive");
  });
  it("resolves nested paths", () => {
    const boxes = [...MAILBOXES, { id: "mb-child", name: "Rescued", role: null, parentId: "mb-archive" }];
    expect(resolveMailbox(boxes, { label: "Rescue", override: "Archive/Rescued", required: true })?.id).toBe("mb-child");
  });
  it("names the available mailboxes when it cannot find one", () => {
    expect(() => resolveMailbox(MAILBOXES, { label: "Rescue", override: "Nope", required: true })).toThrow(/Mailboxes: Inbox, Spam/);
    expect(resolveMailbox(MAILBOXES, { label: "X", role: "nothing", required: false })).toBeUndefined();
  });
});

describe("fetching spam", () => {
  const now = new Date("2026-11-23T20:00:00Z");
  it("queries and gets in one back-referenced round trip", async () => {
    const fake = new FakeJmap({
      emails: [
        spamEmail({
          from: "A@Shop.example",
          name: "Shop",
          subject: "Order",
          preview: "x".repeat(300),
          headers: { "x-spam-score": ["4.5", "0"], "authentication-results": ["mx.messagingengine.com; dmarc=fail", "mx.spammer.example; dmarc=pass"] },
        }),
        spamEmail({ from: "old@x.example", subject: "old", daysAgo: 30 }),
      ],
    });
    const r = await fetchCandidates(client(fake), { junkId: "mb-junk", after: new Date(now.getTime() - 14 * 86_400_000), max: 100, spamHeaders: ["X-Spam-score"], previewChars: 200 });
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]!.calls.map((c) => c[0])).toEqual(["Email/query", "Email/get"]);
    expect(r.total).toBe(1);
    expect(r.candidates[0]).toMatchObject({ fromEmail: "a@shop.example", fromName: "Shop", spamScore: 4.5, auth: { dmarc: "fail" } });
    expect(r.candidates[0]!.preview).toHaveLength(200);
  });
  it("does not even request the body preview when PREVIEW_CHARS is 0", () => {
    expect(emailProperties({ spamHeaders: [], previewChars: 0 })).not.toContain("preview");
  });
  it("drops invalid header names instead of sending them", () => {
    const props = emailProperties({ spamHeaders: ["X-Good", "Bad:Name"], previewChars: 0 });
    expect(props).toContain("header:X-Good:asText:all");
    expect(props.join(" ")).not.toContain("Bad:Name");
  });
  it("falls back to query-then-chunked-get above maxObjectsInGet", async () => {
    const emails = Array.from({ length: 5 }, (_, i) => spamEmail({ from: `s${i}@x.example`, subject: `${i}` }));
    const fake = new FakeJmap({ emails, maxObjectsInGet: 2 });
    const r = await fetchCandidates(client(fake), { junkId: "mb-junk", after: new Date(0), max: 5, spamHeaders: [], previewChars: 0 });
    expect(r.candidates).toHaveLength(5);
  });
});

describe("thread participation", () => {
  const opts = { exclude: ["mb-junk", "mb-trash", "mb-sent"], self: new Set(["owner@owner.example"]) };
  it("finds threads containing mail you received and kept", async () => {
    const a = spamEmail({ from: "a@x.example", subject: "Re: plans", threadId: "TA" });
    const b = spamEmail({ from: "b@x.example", subject: "spam", threadId: "TB" });
    const c = spamEmail({ from: "c@x.example", subject: "spam", threadId: "TC" });
    const fake = new FakeJmap({
      emails: [a, { ...a, id: "A2", mailboxIds: { "mb-inbox": true } }, b, { ...b, id: "B2", mailboxIds: { "mb-trash": true } }, c],
    });
    const found = await threadsWithRealMail(client(fake), ["TA", "TB", "TC"], opts);
    expect([...found]).toEqual(["TA"]);
  });
  it("ignores your own messages: replying to a spammer does not make their thread real", async () => {
    const spam = spamEmail({ from: "spammer@scam.example", subject: "Offer", threadId: "TS" });
    const reply = sentReply("spammer@scam.example", "TS", 3);
    // A copy of your reply filed in Archive (some setups do this) still does not count.
    const archived = { ...sentReply("spammer@scam.example", "TS", 3), mailboxIds: { "mb-archive": true } };
    const followUp = spamEmail({ from: "spammer@scam.example", subject: "Re: Offer", threadId: "TS" });
    const fake = new FakeJmap({ emails: [spam, reply, archived, followUp] });
    expect((await threadsWithRealMail(client(fake), ["TS"], opts)).size).toBe(0);
  });
});

describe("correspondent index", () => {
  const now = new Date("2026-11-23T20:00:00Z");
  const rows = (emails: ReturnType<typeof sentEmail>[]) => emails as SentRow[];
  it("indexes Sent recipients and excludes your own addresses", () => {
    const index = applySent(
      emptyIndex(),
      rows([sentEmail("Friend@Mail.example", 50, "owner@owner.example", now), { ...sentEmail("owner@owner.example", 2, "owner@owner.example", now), cc: [{ email: "colleague@work.example" }] }]),
      1000,
    );
    expect(Object.keys(index.addresses).sort()).toEqual(["colleague@work.example", "friend@mail.example"]);
    expect(index.self).toEqual(["owner@owner.example"]);
    const l = lookup(index);
    expect(l.started("friend@mail.example")).toBeTypeOf("number");
    expect(l.domain("someone@work.example")).toBe(true);
    expect(l.started("owner@owner.example")).toBeUndefined();
  });
  it("records replies separately from conversations you started", () => {
    const index = applySent(
      emptyIndex(),
      rows([
        sentEmail("friend@mail.example", 10),
        sentReply("spammer@scam.example", "TS", 3),
        sentEmail("irt@x.example", 3, undefined, undefined, { inReplyTo: ["<a@b.example>"] }),
        sentEmail("subj@x.example", 3, undefined, undefined, { subject: "RE: invoice" }),
        sentEmail("aw@x.example", 3, undefined, undefined, { subject: "Aw: Termin" }),
      ]),
      1000,
    );
    expect(Object.keys(index.started)).toEqual(["friend@mail.example"]);
    expect(Object.keys(index.addresses)).toHaveLength(5);
    const l = lookup(index);
    expect(l.repliedOnly("spammer@scam.example")).toBe(true);
    expect(l.started("spammer@scam.example")).toBeUndefined();
  });
  it("detects replies conservatively", () => {
    expect(isReply({ subject: "Hello", inReplyTo: null, references: null })).toBe(false);
    expect(isReply({ subject: "Fwd: report", inReplyTo: null, references: null })).toBe(false);
    expect(isReply({ subject: "Re[2]: x", inReplyTo: null, references: null })).toBe(true);
    expect(isReply({ subject: "x", inReplyTo: ["<m@x.example>"], references: null })).toBe(true);
    expect(isReply({ subject: "x", inReplyTo: null, references: ["<m@x.example>"] })).toBe(true);
  });
  it("does not fetch References (a third of the Sent response, never decisive)", () => {
    expect(SENT_PROPERTIES).not.toContain("references");
    expect(SENT_PROPERTIES).toContain("inReplyTo");
  });
  it("is idempotent, so overlapping pages are harmless", () => {
    const page = rows([sentEmail("a@x.example", 3), sentEmail("b@x.example", 2)]);
    const once = applySent(emptyIndex(), page, 1000);
    const twice = applySent(applySent(emptyIndex(), page, 1000), page, 1000);
    expect(twice).toEqual(once);
  });
  it("keeps only the most recent addresses", () => {
    const index = applySent({ v: 3, addresses: { "a@x.example": 1, "b@x.example": 2 }, started: {}, self: [] }, rows([sentEmail("new@x.example", 1, undefined, now)]), 2);
    expect(Object.keys(index.addresses).sort()).toEqual(["b@x.example", "new@x.example"]);
  });
  it("never treats a free webmail domain as known, but still knows the exact address", () => {
    // Built at runtime: the domains have to be real providers here, and the
    // privacy test rightly rejects literal addresses on real domains.
    const at = (local: string, domain: string) => [local, domain].join("@");
    const index = applySent(emptyIndex(), rows([sentEmail(at("friend", "gmail.com"), 5), sentEmail(at("pal", "hotmail.co.uk"), 5), sentEmail("colleague@work.example", 5)]), 1000);
    const l = lookup(index);
    expect(l.domain(at("stranger", "gmail.com"))).toBe(false);
    expect(l.domain(at("stranger", "hotmail.co.uk"))).toBe(false);
    expect(l.domain("stranger@work.example")).toBe(true);
    expect(l.started(at("friend", "gmail.com"))).toBeTypeOf("number");
  });
  it("recognises free webmail domains", () => {
    for (const d of ["gmail.com", "Outlook.com", "hotmail.co.uk", "yahoo.com.au", "live.com", "gmx.de", "icloud.com", "proton.me", "fastmail.com"]) expect(isFreemail(d)).toBe(true);
    for (const d of ["work.example", "outlook.example", "mygmail.com", "yahoo.example.com", "company.co.uk"]) expect(isFreemail(d)).toBe(false);
  });
  it("ignores an index in an older format", () => {
    const old = { v: 2, updatedAt: "", addresses: { "x@x.example": 1 }, started: { "x@x.example": 1 }, self: [] } as unknown as Parameters<typeof lookup>[0];
    expect(lookup(old).started("x@x.example")).toBeUndefined();
  });
});

describe("rescue (the one write)", () => {
  it("moves only messages still in Junk, by patch, to the configured mailbox", async () => {
    const inJunk = spamEmail({ from: "a@x.example", subject: "a", mailboxIds: { "mb-junk": true, "mb-archive": true } });
    const moved = spamEmail({ from: "b@x.example", subject: "b", mailboxIds: { "mb-inbox": true } });
    const fake = new FakeJmap({ emails: [inJunk, moved] });
    const r = await rescue(client(fake, "write-token"), [inJunk.id, moved.id], { junkId: "mb-junk", rescueId: "mb-rescued", max: 10 });
    expect(r.moved).toEqual([inJunk.id]);
    expect(r.skipped).toEqual([{ id: moved.id, reason: "no longer in Spam" }]);
    // Removed from Junk, added to Rescued, other memberships untouched.
    expect(inJunk.mailboxIds).toEqual({ "mb-archive": true, "mb-rescued": true });
    const set = fake.calls.find((c) => c.name === "Email/set")!;
    expect(set.args).not.toHaveProperty("destroy");
    expect(JSON.stringify(set.args)).not.toContain("keywords");
  });
  it("respects its cap (MAX_RESCUES_PER_DIGEST)", async () => {
    const emails = Array.from({ length: 3 }, (_, i) => spamEmail({ from: `${i}@x.example`, subject: `${i}` }));
    const r = await rescue(client(new FakeJmap({ emails }), "write-token"), emails.map((e) => e.id), { junkId: "mb-junk", rescueId: "mb-rescued", max: 2 });
    expect(r.moved).toHaveLength(2);
    expect(r.skipped[0]!.reason).toMatch(/MAX_RESCUES_PER_DIGEST/);
  });
  it("is refused by the server for a read-only token", async () => {
    const e = spamEmail({ from: "a@x.example", subject: "a" });
    await expect(rescue(client(new FakeJmap({ emails: [e] })), [e.id], { junkId: "mb-junk", rescueId: "mb-rescued", max: 5 })).rejects.toThrow(/accountReadOnly/);
  });
  it("refuses to 'rescue' into the Spam mailbox itself", async () => {
    await expect(rescue(client(new FakeJmap(), "write-token"), ["M1"], { junkId: "mb-junk", rescueId: "mb-junk", max: 5 })).rejects.toThrow();
  });
});

describe("digest append", () => {
  it("creates the digest in the Inbox as plain text", async () => {
    const fake = new FakeJmap();
    await appendDigest(client(fake, "write-token"), { subject: "S", text: "T", from: "f@owner.example", to: [] });
    expect(fake.created[0]).toMatchObject({
      mailboxIds: { "mb-inbox": true },
      subject: "S",
      bodyValues: { body: { value: "T" } },
      textBody: [{ partId: "body", type: "text/plain" }],
    });
  });
  it("files it in DIGEST_MAILBOX, by name or path with / or .", async () => {
    const mailboxes = [...MAILBOXES, { id: "mb-lists", name: "Lists", role: null, parentId: null }, { id: "mb-fs", name: "fastspam", role: null, parentId: "mb-lists" }];
    for (const spec of ["Lists/fastspam", "Lists.fastspam", "fastspam"]) {
      const fake = new FakeJmap({ mailboxes });
      await appendDigest(client(fake, "write-token"), { subject: "S", text: "T", from: "", to: [] }, { mailbox: spec });
      expect(fake.created[0]).toMatchObject({ mailboxIds: { "mb-fs": true }, bodyValues: { body: { value: "T" } } });
    }
  });
  it("falls back to the Inbox, saying so, when DIGEST_MAILBOX isn't found", async () => {
    const fake = new FakeJmap();
    await appendDigest(client(fake, "write-token"), { subject: "S", text: "T", from: "", to: [] }, { mailbox: "Renamed" });
    expect(fake.created[0]).toMatchObject({ mailboxIds: { "mb-inbox": true } });
    expect((fake.created[0] as { bodyValues: { body: { value: string } } }).bodyValues.body.value).toMatch(/^\(DIGEST_MAILBOX "Renamed" wasn't found/);
  });
});
