import { CATEGORIES, TIER_OF, TIERS, type Category, type Tier } from "../types.ts";
import type { PromptMessage } from "../ai/classifier.ts";
import { clean, cleanAddress, LIMITS } from "../lib/sanitise.ts";

/**
 * An evaluation case. `label` is the ground truth that matters to fastspam:
 * should this message have been reported? `ambiguous` marks cases a careful
 * person could not call from metadata alone.
 */
export interface EvalFixture {
  id: string;
  label: "legitimate" | "spam" | "ambiguous";
  /** Optional finer label; only used for the category-agreement column. */
  category?: Category;
  /** For legitimate fixtures: the tier it should be reported in (derived from category when absent). */
  tier?: Tier;
  note?: string;
  message: PromptMessage;
}

const LABELS = ["legitimate", "spam", "ambiguous"];

/** Validate a fixture file. Unlabelled entries (label null) are skipped, not errors. */
export function parseFixtures(raw: unknown, source: string): { fixtures: EvalFixture[]; unlabelled: number } {
  const list = Array.isArray(raw) ? raw : (raw as { fixtures?: unknown })?.fixtures;
  if (!Array.isArray(list)) throw new Error(`${source}: expected an array of fixtures`);
  const fixtures: EvalFixture[] = [];
  let unlabelled = 0;
  for (const [i, f] of (list as Record<string, unknown>[]).entries()) {
    const where = `${source}[${i}]`;
    if (f.label === null || f.label === undefined || f.label === "") {
      unlabelled++;
      continue;
    }
    if (!LABELS.includes(String(f.label))) throw new Error(`${where}: label must be one of ${LABELS.join(", ")}`);
    if (f.category !== undefined && !(CATEGORIES as readonly string[]).includes(String(f.category))) {
      throw new Error(`${where}: unknown category ${JSON.stringify(f.category)}`);
    }
    if (f.tier !== undefined && !(TIERS as readonly string[]).includes(String(f.tier))) {
      throw new Error(`${where}: unknown tier ${JSON.stringify(f.tier)}`);
    }
    const category = f.category as Category | undefined;
    const tier =
      f.label !== "legitimate"
        ? undefined
        : ((f.tier as Tier | undefined) ?? (category && category !== "spam" ? TIER_OF[category] : undefined));
    const m = (f.message ?? {}) as Record<string, unknown>;
    // Fixtures go through the same sanitising as live messages.
    const message: PromptMessage = {
      from_name: clean(m.from_name, LIMITS.name),
      from_address: cleanAddress(m.from_address),
      subject: clean(m.subject, LIMITS.subject),
      received_days_ago: typeof m.received_days_ago === "number" ? m.received_days_ago : null,
      domain_known: m.domain_known === true,
      replied_before: m.replied_before === true,
      spam_score: typeof m.spam_score === "number" ? m.spam_score : null,
      auth: clean(m.auth, 120),
    };
    if (typeof m.preview === "string" && m.preview) message.preview = clean(m.preview, LIMITS.preview);
    fixtures.push({
      id: typeof f.id === "string" && f.id ? f.id : `${source}#${i}`,
      label: f.label as EvalFixture["label"],
      ...(f.category ? { category: f.category as Category } : {}),
      ...(tier ? { tier } : {}),
      ...(typeof f.note === "string" ? { note: f.note } : {}),
      message,
    });
  }
  return { fixtures, unlabelled };
}
