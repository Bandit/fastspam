import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFixtures } from "../src/eval/fixtures.ts";
import { calibration, disagreement, recallAtFpBudget, summarise, sweep, type Outcome } from "../src/eval/score.ts";
import { CANDIDATES } from "../src/eval/candidates.ts";
import { MODELS } from "../src/ai/models.ts";
import type { Category, Verdict } from "../src/types.ts";

const v = (top: Category, notSpam: number, tier: Verdict["tier"] = "important"): Verdict => ({ notSpam, top, tier });
const o = (label: Outcome["fixture"]["label"], verdict?: Verdict, category?: Category, tier?: Verdict["tier"]): Outcome => ({
  fixture: { id: Math.random().toString(), label, ...(category ? { category } : {}), ...(tier ? { tier } : {}), message: {} as never },
  verdict,
});

describe("scoring", () => {
  const outcomes = [
    o("legitimate", v("transactional", 0.9), "transactional"),
    o("legitimate", v("personal", 0.55), "account"),
    o("legitimate", undefined),
    o("legitimate", v("unclear", 0.8)),
    o("spam", v("spam", 0.1)),
    o("spam", v("newsletter", 0.7)),
    o("ambiguous", v("unclear", 0.5)),
  ];
  it("sweeps thresholds as the pipeline acts: invalid answers count as misses", () => {
    const rows = sweep(outcomes, [0.5, 0.6, 0.8]);
    expect(rows[0]).toMatchObject({ threshold: 0.5, recall: 0.75, fpPer100: 50, ambiguousReported: 1 });
    expect(rows[1]).toMatchObject({ threshold: 0.6, recall: 0.5, fpPer100: 50 });
    expect(rows[2]).toMatchObject({ threshold: 0.8, recall: 0.5, fpPer100: 0 });
  });
  it("reports recall per expected tier, and which tier wrongly reported spam lands in", () => {
    const set = [
      o("legitimate", v("transactional", 0.9, "important"), undefined, "important"),
      o("legitimate", v("promotional", 0.5, "promotional"), undefined, "promotional"),
      o("legitimate", v("promotional", 0.9, "promotional"), undefined, "promotional"),
      o("spam", v("promotional", 0.7, "promotional")),
      o("spam", v("spam", 0.1, "promotional")),
    ];
    const [row] = sweep(set, [0.6]);
    expect(row!.recallByTier.important).toBe(1);
    expect(row!.recallByTier.promotional).toBe(0.5);
    expect(Number.isNaN(row!.recallByTier.general)).toBe(true);
    expect(row!.fpByTier).toEqual({ important: 0, general: 0, promotional: 1 });
  });
  it("finds the lowest threshold within a false-positive budget", () => {
    expect(recallAtFpBudget(sweep(outcomes, [0.5, 0.6, 0.8]), 10)?.threshold).toBe(0.8);
  });
  it("computes calibration and Brier score, excluding ambiguous and invalid", () => {
    const c = calibration(outcomes);
    expect(c.n).toBe(5);
    const top = c.buckets.at(-1)!;
    expect(top.n).toBe(2);
    expect(top.observed).toBe(1);
    expect(c.brier).toBeGreaterThan(0);
  });
  it("summarises invalid, unclear and category agreement", () => {
    expect(summarise(outcomes)).toMatchObject({ n: 7, invalid: 1, unclearOnAmbiguous: 1, categoryAgreement: 0.5 });
  });
  it("measures batched vs single disagreement by report flips, not just top answers", () => {
    const a = new Map([["x", v("spam", 0.1)], ["y", v("personal", 0.9)], ["z", v("account", 0.8)]]);
    const b = new Map([["x", v("spam", 0.2)], ["y", v("spam", 0.3)], ["z", v("transactional", 0.85)]]);
    const d = disagreement(a, b, 0.6);
    expect(d.compared).toBe(3);
    expect(d.reportFlips).toBeCloseTo(1 / 3);
    expect(d.topDiffers).toBeCloseTo(2 / 3);
  });
});

describe("fixtures", () => {
  it("the committed synthetic set parses, is labelled and is balanced enough to be useful", () => {
    const { fixtures, unlabelled } = parseFixtures(JSON.parse(readFileSync("test/fixtures/eval/synthetic.json", "utf8")), "synthetic");
    expect(unlabelled).toBe(0);
    expect(fixtures.length).toBeGreaterThanOrEqual(30);
    for (const label of ["legitimate", "spam", "ambiguous"]) expect(fixtures.some((f) => f.label === label)).toBe(true);
    expect(fixtures.some((f) => /ignore all previous instructions/i.test(f.message.subject))).toBe(true);
  });
  it("skips unlabelled entries and rejects bad labels", () => {
    expect(parseFixtures([{ label: null, message: {} }], "x").unlabelled).toBe(1);
    expect(() => parseFixtures([{ label: "maybe", message: {} }], "x")).toThrow(/label/);
    expect(() => parseFixtures([{ label: "spam", category: "nope", message: {} }], "x")).toThrow(/category/);
  });
  it("derives expected tiers from categories, and accepts explicit ones", () => {
    const { fixtures } = parseFixtures(
      [
        { label: "legitimate", category: "transactional", message: {} },
        { label: "legitimate", category: "newsletter", message: {} },
        { label: "legitimate", tier: "promotional", message: {} },
        { label: "spam", category: "spam", message: {} },
      ],
      "x",
    );
    expect(fixtures.map((f) => f.tier)).toEqual(["important", "general", "promotional", undefined]);
    expect(() => parseFixtures([{ label: "legitimate", tier: "urgent", message: {} }], "x")).toThrow(/tier/);
  });
  it("sanitises fixture text like live messages", () => {
    const { fixtures } = parseFixtures([{ label: "spam", message: { subject: "a\nb‮", from_address: "X@Y.example" } }], "x");
    expect(fixtures[0]!.message).toMatchObject({ subject: "a b", from_address: "x@y.example" });
  });
  it("every candidate is a known decision model", () => {
    for (const c of CANDIDATES) expect(MODELS[c.model]).toBeDefined();
  });
});
