/**
 * Scoring, the way fastspam acts on a verdict:
 * a message counts as reported only if it would clear the same rule the
 * pipeline uses (isReported). Missing a legitimate message is the failure the
 * tool exists to prevent; reporting a spam message costs a glance. So the
 * headline is recall on legitimate mail at a given false-positive rate, swept
 * across thresholds, not one accuracy number.
 */
import { TIERS, type Tier, type Verdict } from "../types.ts";
import { isReported, notSpam } from "../ai/classifier.ts";
import type { EvalFixture } from "./fixtures.ts";

/** Bump when fixtures, criteria wording, the prompt or scoring change. Scores from different versions are not comparable. */
export const SUITE_VERSION = "2026-11-20.1";

export const THRESHOLDS = [0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

export interface Outcome {
  fixture: EvalFixture;
  /** undefined = no valid verdict (fails closed: not reported) */
  verdict?: Verdict;
}

export interface SweepRow {
  threshold: number;
  /** reported legitimate / all legitimate */
  recall: number;
  /** recall within each expected tier (NaN when the set has none) */
  recallByTier: Record<Tier, number>;
  /** reported spam per 100 spam */
  fpPer100: number;
  /** reported spam, by the tier it would have been shown in */
  fpByTier: Record<Tier, number>;
  /** share of ambiguous cases reported */
  ambiguousReported: number;
}

const ratio = (a: number, b: number) => (b ? a / b : 0);

export function sweep(outcomes: Outcome[], thresholds = THRESHOLDS): SweepRow[] {
  const by = (l: EvalFixture["label"]) => outcomes.filter((o) => o.fixture.label === l);
  const legit = by("legitimate");
  const spam = by("spam");
  const ambiguous = by("ambiguous");
  const reported = (o: Outcome, t: number) => !!o.verdict && isReported(o.verdict, t);
  return thresholds.map((t) => {
    const inTier = (tier: Tier) => legit.filter((o) => o.fixture.tier === tier);
    const recallByTier = Object.fromEntries(
      TIERS.map((tier) => {
        const set = inTier(tier);
        return [tier, set.length ? set.filter((o) => reported(o, t)).length / set.length : Number.NaN];
      }),
    ) as Record<Tier, number>;
    const falsePositives = spam.filter((o) => reported(o, t));
    const fpByTier = Object.fromEntries(TIERS.map((tier) => [tier, falsePositives.filter((o) => o.verdict!.tier === tier).length])) as Record<Tier, number>;
    return {
      threshold: t,
      recall: ratio(legit.filter((o) => reported(o, t)).length, legit.length),
      recallByTier,
      fpPer100: 100 * ratio(falsePositives.length, spam.length),
      fpByTier,
      ambiguousReported: ratio(ambiguous.filter((o) => reported(o, t)).length, ambiguous.length),
    };
  });
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  /** mean P(not spam) the model gave */
  predicted: number;
  /** share that were actually legitimate */
  observed: number;
}

/** Calibration of P(not spam) against labels, ambiguous cases excluded. */
export function calibration(outcomes: Outcome[], buckets = 5): { buckets: CalibrationBucket[]; brier: number; n: number } {
  const usable = outcomes.filter((o) => o.verdict && o.fixture.label !== "ambiguous");
  const out: CalibrationBucket[] = [];
  for (let b = 0; b < buckets; b++) {
    const lo = b / buckets;
    const hi = (b + 1) / buckets;
    const inBucket = usable.filter((o) => {
      const p = notSpam(o.verdict!);
      return p >= lo && (b === buckets - 1 ? p <= hi : p < hi);
    });
    out.push({
      lo,
      hi,
      n: inBucket.length,
      predicted: ratio(inBucket.reduce((s, o) => s + notSpam(o.verdict!), 0), inBucket.length),
      observed: ratio(inBucket.filter((o) => o.fixture.label === "legitimate").length, inBucket.length),
    });
  }
  const brier = ratio(
    usable.reduce((s, o) => s + (notSpam(o.verdict!) - (o.fixture.label === "legitimate" ? 1 : 0)) ** 2, 0),
    usable.length,
  );
  return { buckets: out, brier, n: usable.length };
}

export interface Summary {
  n: number;
  invalid: number;
  /** among legitimate fixtures with an expected tier, share the model put in that tier */
  tierAgreement: number | null;
  /** "unclear" top answers on cases labelled ambiguous / on clear cases (category questions only) */
  unclearOnAmbiguous: number;
  unclearOnClear: number;
  /** among fixtures with a category, share where the model's choice matched */
  categoryAgreement: number | null;
}

export function summarise(outcomes: Outcome[]): Summary {
  const ambiguous = outcomes.filter((o) => o.fixture.label === "ambiguous");
  const clear = outcomes.filter((o) => o.fixture.label !== "ambiguous");
  const withCat = outcomes.filter((o) => o.fixture.category && o.verdict?.top);
  const withTier = outcomes.filter((o) => o.fixture.tier && o.verdict);
  return {
    n: outcomes.length,
    invalid: outcomes.filter((o) => !o.verdict).length,
    tierAgreement: withTier.length ? ratio(withTier.filter((o) => o.verdict!.tier === o.fixture.tier).length, withTier.length) : null,
    unclearOnAmbiguous: ratio(ambiguous.filter((o) => o.verdict?.top === "unclear").length, ambiguous.length),
    unclearOnClear: ratio(clear.filter((o) => o.verdict?.top === "unclear").length, clear.length),
    categoryAgreement: withCat.length ? ratio(withCat.filter((o) => o.verdict!.top === o.fixture.category).length, withCat.length) : null,
  };
}

/**
 * Batched vs one-question-per-call: does putting messages together change
 * answers? `reportFlips` is what matters: messages whose report/don't-report
 * decision changes at the threshold. `topDiffers` counts any change of top
 * answer, including harmless ones like transactional → account.
 */
export function disagreement(
  a: Map<string, Verdict>,
  b: Map<string, Verdict>,
  threshold: number,
): { compared: number; reportFlips: number; topDiffers: number; meanAbsDelta: number } {
  let compared = 0;
  let flips = 0;
  let differs = 0;
  let delta = 0;
  for (const [id, va] of a) {
    const vb = b.get(id);
    if (!vb) continue;
    compared++;
    if (isReported(va, threshold) !== isReported(vb, threshold)) flips++;
    if (va.top !== vb.top) differs++;
    delta += Math.abs(notSpam(va) - notSpam(vb));
  }
  return { compared, reportFlips: ratio(flips, compared), topDiffers: ratio(differs, compared), meanAbsDelta: ratio(delta, compared) };
}

/** Lowest threshold whose false-positive rate stays within the budget, and its recall. */
export function recallAtFpBudget(rows: SweepRow[], fpPer100Budget: number): SweepRow | undefined {
  return rows.filter((r) => r.fpPer100 <= fpPer100Budget).sort((x, y) => x.threshold - y.threshold)[0];
}
