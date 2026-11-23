/**
 * Shared types. Everything here is data: no model output is ever turned into
 * an identifier, a URL or an operation (see README "How decisions are made").
 */

/** The Workers AI binding, typed loosely so third-party model ids are allowed. */
export interface AiBinding {
  run(model: string, input: unknown, options?: unknown): Promise<unknown>;
}

export interface Env {
  FASTSPAM_STATE: KVNamespace;
  AI?: AiBinding;
  EMAIL?: SendEmail;
  FASTMAIL_TOKEN?: string;
  FASTMAIL_WRITE_TOKEN?: string;
  POSTMARK_SERVER_TOKEN?: string;
  [key: string]: unknown;
}

/** The closed set of answers a decision model may give. */
export const CATEGORIES = ["spam", "transactional", "personal", "account", "newsletter", "promotional", "unclear"] as const;
export type Category = (typeof CATEGORIES)[number];

/**
 * How much a reported message matters, like an alerting tool's severities. Facts are
 * always `important`; a model verdict's tier is the tier with the most
 * probability summed over its categories.
 */
export const TIERS = ["important", "general", "promotional"] as const;
export type Tier = (typeof TIERS)[number];

export const TIER_OF: Record<Exclude<Category, "spam">, Tier> = {
  transactional: "important",
  personal: "important",
  account: "important",
  newsletter: "general",
  unclear: "general",
  promotional: "promotional",
};

/** Why a message was reported. Only `model` involves a model. */
export type Basis = "allowlist" | "correspondent" | "thread" | "model";

export const DETERMINISTIC_BASES: readonly Basis[] = ["allowlist", "correspondent", "thread"];

export type AuthResult = "pass" | "fail" | "softfail" | "neutral" | "none" | "temperror" | "permerror" | "policy" | "invalid";

export interface AuthSummary {
  spf?: AuthResult;
  dkim?: AuthResult;
  dmarc?: AuthResult;
  /** The From domain's published DMARC policy, when the receiver reports it. */
  dmarcPolicy?: "none" | "quarantine" | "reject";
}

/** One message from the Spam folder, as fetched (not yet sanitised). */
export interface Candidate {
  id: string;
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  receivedAt: string;
  preview: string;
  /** Parsed from the first SPAM_HEADERS header present, if any. */
  spamScore: number | null;
  /** Raw values of the SPAM_HEADERS that were present (for the preview script). */
  spamHeaders: Record<string, string>;
  auth: AuthSummary;
  /** Marked read ($seen). */
  seen?: boolean;
}

export interface Verdict {
  /** P(not spam): the one number the reporting rule uses. */
  notSpam: number;
  /** The model's top answer (category questions only). */
  top?: Category;
  /** Most likely category within the winning tier, for display (category questions only). */
  category?: Exclude<Category, "spam">;
  /** Which tier the message belongs in, if reported. Yes/no questions give "general". */
  tier: Tier;
  /** Full distribution (category questions only). */
  probabilities?: Record<Category, number>;
  /** The model's own confidence, when it reports one. */
  confidence?: number;
}

/** "categories": six-way choice question. "yesno": one yes/no question. */
export type QuestionStyle = "categories" | "yesno";

export interface Suspect {
  candidate: Candidate;
  basis: Basis;
  tier: Tier;
  /** Human-readable fact behind the report, built by code (never model text). */
  detail: string;
  verdict?: Verdict;
}

export interface RescueResult {
  moved: string[];
  skipped: { id: string; reason: string }[];
}
