import type { Item } from "./classifier.ts";
import { CRITERIA, NO_MEANS, questionText, YES_MEANS, yesNoText } from "./classifier.ts";

/** Rough token estimate: ~3 characters per token is deliberately pessimistic. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 3);
}

const PER_QUESTION =
  Math.max(estimateTokens(questionText("m000") + Object.values(CRITERIA).join(" ")), estimateTokens(yesNoText("m000") + YES_MEANS + NO_MEANS)) + 16;
const PAYLOAD_OVERHEAD = 400;

export function estimateItemTokens(item: Item): number {
  return estimateTokens(JSON.stringify(item.message)) + 8 + PER_QUESTION;
}

/**
 * Split items into batches of at most `maxSize` questions whose estimated size
 * stays under half of `contextTokens`. Overflowing questions fail a request
 * outright, and Clef silently truncates an oversize `state`, so staying far
 * below the window is the only safe policy.
 */
export function makeBatches(items: Item[], maxSize: number, contextTokens: number): Item[][] {
  const budget = Math.max(1000, Math.floor(contextTokens / 2)) - PAYLOAD_OVERHEAD;
  const out: Item[][] = [];
  let current: Item[] = [];
  let used = 0;
  for (const item of items) {
    const t = estimateItemTokens(item);
    if (current.length && (current.length >= maxSize || used + t > budget)) {
      out.push(current);
      current = [];
      used = 0;
    }
    current.push(item);
    used += t;
  }
  if (current.length) out.push(current);
  return out;
}
