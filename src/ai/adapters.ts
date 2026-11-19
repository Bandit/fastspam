/**
 * Request/response translation for each decision endpoint. Shapes are from
 * Cloudflare's published schema-input.json / schema-output.json for each model.
 *
 *              payload  questions            choice options        yes/no question            yes/no answer
 *   Clef       state    map key → question   criteria map          noul, criteria {true,false}  { noul }
 *   Gemini     input    map key → question   criteria map          noul, {true_description,…}   { noul, confidence }
 *   OpenAI     input    array, `name` = key  choices [{value,…}]   predicate                    { probability }
 */
import { CATEGORIES, type QuestionStyle } from "../types.ts";
import type { AdapterKind } from "./models.ts";
import { CRITERIA, NO_MEANS, questionText, YES_MEANS, yesNoText, type Item, type RawBinary, type RawChoice } from "./classifier.ts";

export interface Parsed {
  answers: Map<string, RawChoice | RawBinary>;
  warnings: string[];
}

export interface Adapter {
  buildRequest(model: string, items: Item[], payload: string, style: QuestionStyle): Record<string, unknown>;
  parseAnswers(output: unknown, keys: string[], style: QuestionStyle): Parsed;
}

function mapQuestions(items: Item[], style: QuestionStyle, yesNoCriteria: Record<string, string>) {
  return Object.fromEntries(
    items.map((i) => [
      i.key,
      style === "yesno"
        ? { type: "noul", instructions: yesNoText(i.key), criteria: yesNoCriteria }
        : { type: "choice", instructions: questionText(i.key), criteria: CRITERIA },
    ]),
  );
}

/** Clef and Gemini: answers keyed by question id; yes/no answers carry `noul`. */
function parseMap(output: unknown, keys: string[], style: QuestionStyle): Parsed {
  const answers = new Map<string, RawChoice | RawBinary>();
  const warnings: string[] = [];
  const raw = (output as { answers?: unknown } | null)?.answers;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { answers, warnings: ["response has no answers object"] };
  const record = raw as Record<string, Record<string, unknown> | undefined>;
  for (const k of Object.keys(record)) if (!keys.includes(k)) warnings.push(`ignored answer for unknown question ${JSON.stringify(k).slice(0, 40)}`);
  for (const k of keys) {
    const a = record[k];
    if (!a || typeof a !== "object") continue;
    if (style === "yesno") answers.set(k, { type: a.type === "noul" ? "binary" : a.type, probability: a.noul, confidence: a.confidence });
    else answers.set(k, a as RawChoice);
  }
  return { answers, warnings };
}

export const clef: Adapter = {
  buildRequest: (model, items, payload, style) => ({
    // Clef takes its variant name inside the input as well as in the model id.
    model: model.replace(/^@cf\/cloudflare\//, ""),
    state: payload,
    questions: mapQuestions(items, style, { true: YES_MEANS, false: NO_MEANS }),
  }),
  parseAnswers: parseMap,
};

export const gemini: Adapter = {
  buildRequest: (_model, items, payload, style) => ({
    input: payload,
    questions: mapQuestions(items, style, { true_description: YES_MEANS, false_description: NO_MEANS }),
  }),
  parseAnswers: parseMap,
};

export const openai: Adapter = {
  buildRequest: (_model, items, payload, style) => ({
    input: payload,
    questions: items.map((i) =>
      style === "yesno"
        ? { name: i.key, type: "predicate", instructions: `${yesNoText(i.key)} Yes means: ${YES_MEANS}. No means: ${NO_MEANS}.` }
        : {
            name: i.key,
            type: "choice",
            instructions: questionText(i.key),
            choices: CATEGORIES.map((c) => ({ value: c, description: CRITERIA[c] })),
          },
    ),
  }),
  parseAnswers(output, keys, style) {
    const answers = new Map<string, RawChoice | RawBinary>();
    const warnings: string[] = [];
    const raw = (output as { answers?: unknown } | null)?.answers;
    if (!Array.isArray(raw)) return { answers, warnings: ["response has no answers array"] };
    for (const a of raw as Record<string, unknown>[]) {
      // Matched by the name we set, never by position.
      const name = typeof a?.name === "string" ? a.name : null;
      if (!name || !keys.includes(name)) {
        warnings.push("ignored answer with a missing or unknown name");
        continue;
      }
      if (answers.has(name)) {
        warnings.push(`duplicate answer for ${name}; kept the first`);
        continue;
      }
      if (a.type === "refusal") {
        warnings.push(`model refused ${name}`);
        continue;
      }
      if (style === "yesno") {
        answers.set(name, { type: a.type === "predicate" ? "binary" : a.type, probability: a.probability, confidence: a.confidence });
        continue;
      }
      let probabilities: Record<string, unknown> | undefined;
      if (Array.isArray(a.probabilities)) {
        probabilities = {};
        for (const p of a.probabilities as { value?: unknown; probability?: unknown }[]) {
          const v = String(p?.value);
          // A repeated value would make the distribution ambiguous: poison it so validation rejects.
          probabilities[v] = v in probabilities ? Number.NaN : p?.probability;
        }
      }
      answers.set(name, {
        type: a.type,
        choice: typeof a.choice === "boolean" ? String(a.choice) : a.choice,
        confidence: a.confidence,
        probabilities,
      });
    }
    return { answers, warnings };
  },
};

export const ADAPTERS: Record<AdapterKind, Adapter> = { clef, gemini, openai };
