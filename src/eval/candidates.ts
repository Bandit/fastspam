/** The models the evaluation harness compares. Select by id: --candidates clef,gemini-decision */
export interface EvalCandidate {
  id: string;
  name: string;
  model: string;
}

export const CANDIDATES: EvalCandidate[] = [
  { id: "clef", name: "Clef", model: "@cf/cloudflare/clef" },
  { id: "clef-flash", name: "Clef Flash", model: "@cf/cloudflare/clef-flash" },
  { id: "clef-omni", name: "Clef Omni", model: "@cf/cloudflare/clef-omni" },
  { id: "gemini-decision", name: "Gemini Decision 1", model: "google/gemini-decision-1" },
  { id: "openai-decisions", name: "OpenAI Decisions (GPT-6 Luna)", model: "openai/decisions" },
];
