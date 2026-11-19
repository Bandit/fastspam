/**
 * The supported decision models. All three are constrained endpoints that
 * score caller-defined options and return probabilities with zero output
 * tokens; none can return free text. Facts below are from Cloudflare's model
 * pages and schemas (November 2026); see README "Choosing a model".
 */
export type AdapterKind = "clef" | "gemini" | "openai";

export interface ModelInfo {
  adapter: AdapterKind;
  /** Third-party models go through AI Gateway on Unified Billing. */
  requiresGateway: boolean;
  /** Documented maximum questions per call. */
  maxQuestions: number;
  /** Documented context window, in tokens. */
  contextTokens: number;
  /** USD per million input tokens (output is not charged for any of them). */
  inputPricePerM: number;
  /** Clef documents "values sum to 1"; the others do not. */
  probabilitiesSumToOne: boolean;
}

export const MODELS: Record<string, ModelInfo> = {
  "@cf/cloudflare/clef": {
    adapter: "clef",
    requiresGateway: false,
    maxQuestions: 64,
    contextTokens: 65_536,
    inputPricePerM: 0.24,
    probabilitiesSumToOne: true,
  },
  "@cf/cloudflare/clef-flash": {
    adapter: "clef",
    requiresGateway: false,
    maxQuestions: 64,
    contextTokens: 24_576,
    inputPricePerM: 0.038,
    probabilitiesSumToOne: true,
  },
  // 30B mixture-of-experts (3B active). Limits from its model page and schema.
  "@cf/cloudflare/clef-omni": {
    adapter: "clef",
    requiresGateway: false,
    maxQuestions: 64,
    contextTokens: 64_000,
    inputPricePerM: 0.15,
    probabilitiesSumToOne: true,
  },
  "google/gemini-decision-1": {
    adapter: "gemini",
    requiresGateway: true,
    maxQuestions: 1000,
    contextTokens: 262_144,
    inputPricePerM: 0.1,
    probabilitiesSumToOne: false,
  },
  // GPT-6 Luna behind OpenAI's Decisions API. Cloudflare's schema allows 200
  // questions (OpenAI's own guide says 400); we use the stricter number.
  "openai/decisions": {
    adapter: "openai",
    requiresGateway: true,
    maxQuestions: 200,
    contextTokens: 1_050_000,
    inputPricePerM: 0.1,
    probabilitiesSumToOne: false,
  },
};

/**
 * Clef: the default because it needs no setup (no AI Gateway, no credits), and
 * of the models on the free allocation it caught the most important mail.
 * Gemini Decision did clearly better on real mail at every batch size; the
 * README recommends it for anyone who can set up AI Gateway.
 */
export const DEFAULT_MODEL = "@cf/cloudflare/clef";

export function modelInfo(model: string): ModelInfo | undefined {
  return MODELS[model];
}
