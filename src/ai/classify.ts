import type { AiBinding, QuestionStyle, Verdict } from "../types.ts";
import type { Budget } from "../lib/budget.ts";
import { ADAPTERS } from "./adapters.ts";
import { makeBatches } from "./batch.ts";
import { buildPayload, validateBinary, validateChoice, type Item, type RawBinary, type RawChoice, type ReviewContext } from "./classifier.ts";
import { modelInfo } from "./models.ts";

/** Subrequests kept back for what happens after classification. */
const RESERVE = 8;

export interface ClassifyOptions {
  model: string;
  gatewayId: string;
  batchSize: number;
  maxCalls: number;
  /** Default "categories". */
  style?: QuestionStyle;
  /** Calls in flight at once. The Worker uses 1; the evaluation harness more. */
  concurrency?: number;
  /** Retries for rate-limited calls (default 3). Each retry counts against the budget. */
  retries?: number;
  /** Injectable for tests. */
  sleep?: (ms: number) => Promise<void>;
  contextTokens?: number | null;
  budget?: Budget;
  /** Injectable for tests; defaults to crypto.randomUUID. */
  nonce?: () => string;
  /** What the model is told about where the messages came from. Default "junk". */
  context?: ReviewContext;
}

export interface ClassifyResult {
  /** Valid verdicts keyed by item key. Items absent here were not classified (fail closed). */
  verdicts: Map<string, Verdict>;
  calls: number;
  inputTokens: number;
  /** Items that never reached a model (call cap, budget, or an earlier fatal error). */
  skipped: number;
  /** Items whose answer was missing or rejected. */
  rejected: number;
  failures: string[];
  warnings: string[];
  latencyMs: number[];
  /** Rate-limited calls that were retried. */
  retries: number;
}

/** Workers AI error 3036: the free daily allocation is used up until 00:00 UTC. */
export function isAllocationExhausted(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b3036\b|daily free allocation/i.test(m);
}

/**
 * Some third-party models answer through the binding inside a job envelope,
 * `{ state: "Completed", result: { answers, usage } }` (observed for
 * google/gemini-decision-1; not on its model page). Unwrap it; any other state
 * means no answer.
 */
export function unwrapEnvelope(output: unknown): { output?: unknown; error?: string } {
  const o = output as { state?: unknown; result?: unknown } | null;
  if (o && typeof o === "object" && "state" in o && "result" in o) {
    if (o.state !== "Completed") return { error: `model job state ${JSON.stringify(o.state).slice(0, 40)}` };
    return { output: o.result };
  }
  return { output };
}

/** Rate limits (AI Gateway Unified Billing 2018, HTTP 429, Workers AI 3040 "out of capacity") are worth retrying. */
export function isRetryable(err: unknown): boolean {
  const m = err instanceof Error ? err.message : String(err);
  return /\b(2018|3040|429)\b|rate limit|out of capacity|retry shortly/i.test(m) && !isAllocationExhausted(err);
}

/** Backoff before retry n (0-based): ~0.5 s, 1.5 s, 4 s, with jitter. */
const BACKOFF_MS = [500, 1500, 4000];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function usageInputTokens(output: unknown): number {
  const u = (output as { usage?: Record<string, unknown> } | null)?.usage ?? {};
  const n = Number(u.input_tokens ?? u.total_input_tokens ?? u.prompt_tokens ?? 0);
  return Number.isFinite(n) ? n : 0;
}

export async function classify(ai: AiBinding | undefined, items: Item[], opts: ClassifyOptions): Promise<ClassifyResult> {
  const result: ClassifyResult = {
    verdicts: new Map(),
    calls: 0,
    inputTokens: 0,
    skipped: 0,
    rejected: 0,
    failures: [],
    warnings: [],
    latencyMs: [],
    retries: 0,
  };
  if (!items.length) return result;

  const info = modelInfo(opts.model);
  const refuse = (msg: string) => {
    result.failures.push(msg);
    result.skipped = items.length;
    return result;
  };
  if (!info) return refuse(`AI_MODEL "${opts.model}" is not a supported decision model`);
  if (!ai) return refuse("the AI binding is missing");
  if (info.requiresGateway && !opts.gatewayId) {
    return refuse(`${opts.model} runs through AI Gateway: set AI_GATEWAY_ID (and AI Gateway credits)`);
  }

  const adapter = ADAPTERS[info.adapter];
  const style: QuestionStyle = opts.style ?? "categories";
  const batches = makeBatches(items, Math.min(opts.batchSize, info.maxQuestions), opts.contextTokens ?? info.contextTokens);
  const options = opts.gatewayId ? { gateway: { id: opts.gatewayId } } : undefined;
  const nonce = opts.nonce ?? (() => crypto.randomUUID());

  const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

  /** One call. Returns "exhausted" when the free allocation is used up. */
  const runBatch = async (batch: Item[]): Promise<"ok" | "exhausted"> => {
    const keys = batch.map((i) => i.key);
    const request = adapter.buildRequest(opts.model, batch, buildPayload(batch, nonce(), opts.context), style);
    let output: unknown;
    const started = Date.now();
    const wait = opts.sleep ?? sleep;
    const maxRetries = opts.retries ?? 3;
    try {
      for (let attempt = 0; ; attempt++) {
        try {
          output = await ai.run(opts.model, request, options);
          break;
        } catch (err) {
          // Retry only rate limits, and only while the budget allows another call.
          if (!isRetryable(err) || attempt >= maxRetries || (opts.budget && opts.budget.remaining <= RESERVE)) throw err;
          opts.budget?.take();
          result.retries++;
          await wait(BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)]! * (0.75 + Math.random() / 2));
        }
      }
    } catch (err) {
      result.latencyMs.push(Date.now() - started);
      if (isAllocationExhausted(err)) {
        result.skipped += batch.length;
        return "exhausted";
      }
      result.rejected += batch.length;
      result.failures.push(`model call failed for ${batch.length} message(s): ${(err instanceof Error ? err.message : String(err)).slice(0, 200)}`);
      return "ok";
    }
    result.latencyMs.push(Date.now() - started);
    const unwrapped = unwrapEnvelope(output);
    if (unwrapped.error) {
      result.rejected += batch.length;
      result.failures.push(`no answer for ${batch.length} message(s): ${unwrapped.error}`);
      return "ok";
    }
    output = unwrapped.output;
    result.inputTokens += usageInputTokens(output);

    const parsed = adapter.parseAnswers(output, keys, style);
    result.warnings.push(...parsed.warnings);
    for (const key of keys) {
      const raw = parsed.answers.get(key);
      const v = style === "yesno" ? validateBinary(raw as RawBinary | undefined) : validateChoice(raw as RawChoice | undefined, info.probabilitiesSumToOne);
      if (v.warning) result.warnings.push(`${key}: ${v.warning}`);
      if (v.verdict) result.verdicts.set(key, v.verdict);
      else {
        result.rejected++;
        result.warnings.push(`${key}: rejected (${v.error})`);
      }
    }
    return "ok";
  };

  let next = 0;
  const leftFrom = (i: number) => batches.slice(i).flat().length;
  while (next < batches.length) {
    const wave: Promise<"ok" | "exhausted">[] = [];
    let stop: string | undefined;
    while (next < batches.length && wave.length < concurrency) {
      if (result.calls >= opts.maxCalls) {
        stop = `MAX_MODEL_CALLS_PER_RUN (${opts.maxCalls}) reached`;
        break;
      }
      if (opts.budget && opts.budget.remaining <= RESERVE) {
        // Keep budget for a rescue and for sending the digest (Fastmail: 3 requests).
        stop = "subrequest budget nearly spent";
        break;
      }
      opts.budget?.take();
      result.calls++;
      wave.push(runBatch(batches[next++]!));
    }
    const statuses = await Promise.all(wave);
    if (statuses.includes("exhausted")) {
      const rest = leftFrom(next);
      result.skipped += rest;
      const total = result.skipped;
      result.failures.push(`Workers AI free allocation used up (resets 00:00 UTC); ${total} message(s) not classified`);
      break;
    }
    if (stop) {
      const rest = leftFrom(next);
      result.skipped += rest;
      result.failures.push(`${stop}; ${rest} message(s) not classified this run`);
      break;
    }
  }
  return result;
}
