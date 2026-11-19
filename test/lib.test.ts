import { describe, expect, it } from "vitest";
import { clean, cleanAddress, domainOf } from "../src/lib/sanitise.ts";
import { matchesAny, matchesPattern } from "../src/lib/match.ts";
import { firstHeader, isValidHeaderName, parseAuthResults, parseSpamScore } from "../src/lib/headers.ts";
import { addLines } from "../src/lib/state.ts";
import { Budget, BudgetExceededError } from "../src/lib/budget.ts";

describe("sanitise", () => {
  it("strips control characters and collapses whitespace to one line", () => {
    expect(clean("Hello\r\n\tworld\u0007 !", 50)).toBe("Hello world !");
  });
  it("removes bidi overrides and zero-width characters", () => {
    expect(clean("pay‮exe.pdf​", 50)).toBe("payexe.pdf");
    expect(clean("﻿abc⁦def⁩", 50)).toBe("abcdef");
  });
  it("caps length by code point and marks truncation", () => {
    expect(clean("abcdefghij", 5)).toBe("abcd…");
    expect(Array.from(clean("😀".repeat(10), 4))).toHaveLength(4);
    // Longer than max in UTF-16 units, but not in code points: kept whole.
    expect(clean("😀".repeat(3), 4)).toBe("😀".repeat(3));
    // Non-ASCII is still normalised to NFC.
    expect(clean("Cafe\u0301", 10)).toBe("Caf\u00e9");
  });
  it("returns empty for non-strings", () => {
    expect(clean(undefined, 10)).toBe("");
    expect(clean(42, 10)).toBe("");
  });
  it("lower-cases addresses and finds domains", () => {
    expect(cleanAddress(" Alice@Example.COM ")).toBe("alice@example.com");
    expect(domainOf("a@b.example")).toBe("b.example");
    expect(domainOf("nodomain")).toBe("");
  });
});

describe("match", () => {
  it("matches exact addresses case-insensitively", () => {
    expect(matchesPattern("Alice@Shop.example", "alice@shop.example")).toBe(true);
    expect(matchesPattern("bob@shop.example", "alice@shop.example")).toBe(false);
  });
  it("matches bare domains, @domain and *@domain, including subdomains", () => {
    for (const p of ["shop.example", "@shop.example", "*@shop.example"]) {
      expect(matchesPattern("a@shop.example", p)).toBe(true);
      expect(matchesPattern("a@mail.shop.example", p)).toBe(true);
      expect(matchesPattern("a@evilshop.example", p)).toBe(false);
    }
  });
  it("supports * within an address and never crosses the @", () => {
    expect(matchesPattern("news-nz@shop.example", "news-*@shop.example")).toBe(true);
    expect(matchesPattern("news@x.example", "news*shop.example")).toBe(false);
  });
  it("escapes regex characters in patterns", () => {
    expect(matchesPattern("a@shopxexample", "a@shop.example")).toBe(false);
  });
  it("returns the first matching pattern", () => {
    expect(matchesAny("a@shop.example", ["other.example", "shop.example"])).toBe("shop.example");
    expect(matchesAny("", ["shop.example"])).toBeUndefined();
  });
});

describe("headers", () => {
  it("validates JMAP header names", () => {
    expect(isValidHeaderName("X-Spam-score")).toBe(true);
    expect(isValidHeaderName("Bad:Name")).toBe(false);
    expect(isValidHeaderName("Bad Name")).toBe(false);
  });
  it("parses spam scores in common forms", () => {
    expect(parseSpamScore("5.2")).toBe(5.2);
    expect(parseSpamScore("score=7.1")).toBe(7.1);
    expect(parseSpamScore("Yes, score=-1.5 required=5.0")).toBe(-1.5);
    expect(parseSpamScore("garbage")).toBeNull();
    expect(parseSpamScore(null)).toBeNull();
  });
  it("merges Fastmail's separate Authentication-Results instances", () => {
    // The real layout: one instance per check, all stamped with Fastmail's MX.
    const fastmail = [
      "phl-mx-07.messagingengine.com; x-csa=none; x-me-sender=none; x-ptr=pass smtp.helo=h.example",
      "phl-mx-07.messagingengine.com; bimi=skipped (No DMARC)",
      "phl-mx-07.messagingengine.com; arc=none (no signatures found)",
      "phl-mx-07.messagingengine.com; dkim2=none; dkim=invalid (public key: not available) header.d=agency.example; dmarc=fail policy.published-domain-policy=quarantine header.from=agency.example",
      "phl-mx-07.messagingengine.com; spf=fail smtp.mailfrom=agency.example",
    ];
    expect(parseAuthResults(fastmail)).toEqual({ dkim: "invalid", dmarc: "fail", dmarcPolicy: "quarantine", spf: "fail" });
  });
  it("ignores Authentication-Results from servers other than the trusted receiver", () => {
    // A sender can write their own header claiming everything passed.
    const forged = ["mx.evil.example; spf=pass; dkim=pass; dmarc=pass", "messagingengine.com.evil.example; dmarc=pass"];
    expect(parseAuthResults(forged)).toEqual({});
    expect(parseAuthResults([...forged, "mx.messagingengine.com; dmarc=fail"])).toEqual({ dmarc: "fail" });
    expect(parseAuthResults(["mx.other.example; dmarc=pass"], ["other.example"])).toEqual({ dmarc: "pass" });
  });
  it("does not mistake dkim2 or unknown values for results", () => {
    expect(parseAuthResults(["mx.messagingengine.com; dkim2=pass; dmarc=bogus"])).toEqual({});
  });
  it("uses the topmost instance of a repeated header", () => {
    // The receiving server's header is prepended; later ones may be the sender's own forgeries.
    expect(firstHeader(["dmarc=fail", "dmarc=pass"])).toBe("dmarc=fail");
    expect(firstHeader(["", "x"])).toBe("x");
    expect(firstHeader([])).toBeNull();
  });
});

describe("state and budget", () => {
  it("keeps failure and note lines deduplicated and capped", () => {
    const lines: string[] = [];
    addLines(lines, ["a", "a", "b"]);
    expect(lines).toEqual(["a", "b"]);
    addLines(lines, Array.from({ length: 50 }, (_, i) => `x${i}`));
    expect(lines).toHaveLength(20);
  });
  it("enforces the subrequest budget but lets charge() count past it", () => {
    const b = new Budget(2);
    b.take();
    b.take();
    expect(() => b.take()).toThrow(BudgetExceededError);
    b.charge();
    expect(b.used).toBe(3);
  });
});

describe("config", () => {
  it('treats "unused" digest addresses (as the deploy button suggests) as empty', async () => {
    const { loadConfig } = await import("../src/config.ts");
    const c = loadConfig({ FASTSPAM_STATE: {} as KVNamespace, EMAIL_FROM: "unused", EMAIL_TO: "unused" });
    expect(c.emailFrom).toBe("");
    expect(c.emailTo).toEqual([]);
    expect(loadConfig({ FASTSPAM_STATE: {} as KVNamespace, EMAIL_FROM: "me@x.example", EMAIL_TO: "a@x.example, unused" }).emailTo).toEqual(["a@x.example"]);
  });
});
