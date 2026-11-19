#!/usr/bin/env node
/**
 * Compare decision models on labelled fixtures, scored the way fastspam acts.
 *
 *   npm run evaluate
 *   npm run evaluate -- --candidates clef-omni,gemini-decision,openai-decisions --style both
 *   npm run evaluate -- --set private --compare-batching
 *
 * Options: --set synthetic|private|shareable|all (default all available;
 *            shareable = synthetic + private files marked "external": true)
 *          --style categories|yesno|both (default categories)
 *          --batch-size N · --threshold 0.6 · --fp-budget 5 (FP per 100 spam)
 *          --concurrency 4 (calls in flight at once; rate-limited calls are retried)
 *          --keep-scores   keep spam_score (blanked by default: legitimate mail
 *                          sampled from the Inbox has low scores, which would let
 *                          a model cheat)
 *
 * Private files marked "external": false (mail you kept) are NEVER sent to
 * models that run outside Cloudflare unless you name the provider:
 * --allow-external-private google   (or "google,openai"). Check the provider's
 * data retention first (Cloudflare's model catalogue lists ZDR per model).
 * Candidates without permission are scored on the rest of the set, and the
 * table says how many fixtures each row used.
 *
 * Results go to eval-results/ (gitignored). Only aggregate numbers belong in
 * the README; never copy private fixtures or their content anywhere public.
 * The Gemini and OpenAI candidates need AI_GATEWAY_ID and AI Gateway credits.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadEnv, flag, option } from "./env.mjs";

const { classify } = await import("../src/ai/classify.ts");
const { modelInfo } = await import("../src/ai/models.ts");
const { CANDIDATES } = await import("../src/eval/candidates.ts");
const { parseFixtures } = await import("../src/eval/fixtures.ts");
const { SUITE_VERSION, sweep, calibration, summarise, disagreement, recallAtFpBudget } = await import("../src/eval/score.ts");

const setName = option("set", "all");
const batchSize = Number(option("batch-size", "16"));
const threshold = Number(option("threshold", "0.6"));
const fpBudget = Number(option("fp-budget", "5"));
const compare = flag("compare-batching");
const keepScores = flag("keep-scores");
const styleOpt = option("style", "categories");
const styles = styleOpt === "both" ? ["categories", "yesno"] : [styleOpt];
const wanted = option("candidates", CANDIDATES.map((c) => c.id).join(",")).split(",");

// Providers (the part of a model id before "/") allowed to receive private data.
const allowExternalPrivate = option("allow-external-private", "")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
if (flag("allow-external-private") && !allowExternalPrivate.length) {
  throw new Error('--allow-external-private needs provider names, e.g. --allow-external-private google');
}
function load(path) {
  const raw = JSON.parse(readFileSync(path, "utf8"));
  const { fixtures, unlabelled } = parseFixtures(raw, path);
  if (unlabelled) console.error(`${path}: skipped ${unlabelled} unlabelled entr${unlabelled === 1 ? "y" : "ies"}`);
  // Synthetic data may go anywhere; private data only where its file says so.
  const external = path.startsWith("test/") || raw.external === true;
  for (const f of fixtures) f.external = external;
  return fixtures;
}
const fixtures = [];
if (setName !== "private") fixtures.push(...load("test/fixtures/eval/synthetic.json"));
if (setName !== "synthetic" && existsSync("eval-private")) {
  for (const f of readdirSync("eval-private").filter((f) => f.endsWith(".json"))) {
    const loaded = load(`eval-private/${f}`);
    fixtures.push(...(setName === "shareable" ? loaded.filter((x) => x.external) : loaded));
  }
}
if (!fixtures.length) throw new Error("no labelled fixtures found");
if (!keepScores) for (const f of fixtures) f.message.spam_score = null;
const count = (l) => fixtures.filter((f) => f.label === l).length;
const pct = (x) => `${(x * 100).toFixed(0)}%`;
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

const { env, dispose } = await loadEnv();
const results = [];
try {
  const gatewayId = typeof env.AI_GATEWAY_ID === "string" ? env.AI_GATEWAY_ID.trim() : "";
  for (const cand of CANDIDATES.filter((c) => wanted.includes(c.id))) {
    const info0 = modelInfo(cand.model);
    const provider = cand.model.split("/")[0].toLowerCase();
    const set = info0.requiresGateway && !allowExternalPrivate.includes(provider) ? fixtures.filter((f) => f.external) : fixtures;
    if (set.length < fixtures.length) console.error(`${cand.name}: withholding ${fixtures.length - set.length} private fixture(s) that may not leave Cloudflare`);
    const items = set.map((f, i) => ({ key: `m${i}`, message: f.message }));
    for (const style of styles) {
      const label = `${cand.name} · ${style}`;
      const info = modelInfo(cand.model);
      if (info.requiresGateway && !gatewayId) {
        console.error(`skipping ${label}: needs AI_GATEWAY_ID`);
        results.push({ candidate: cand, style, skipped: "needs AI_GATEWAY_ID" });
        continue;
      }
      console.error(`running ${label} on ${items.length} fixture(s)…`);
      const opts = { model: cand.model, gatewayId, maxCalls: 1_000_000, style, concurrency: Number(option("concurrency", "4")) };
      const batched = await classify(env.AI, items, { ...opts, batchSize });
      const outcomes = set.map((f, i) => ({ fixture: f, verdict: batched.verdicts.get(`m${i}`) }));
      const rows = sweep(outcomes);
      const single = compare ? await classify(env.AI, items, { ...opts, batchSize: 1 }) : undefined;
      results.push({
        candidate: cand,
        style,
        fixtures: set.length,
        legit: set.filter((f) => f.label === "legitimate").length,
        rows,
        at: rows.find((r) => r.threshold === threshold),
        best: recallAtFpBudget(rows, fpBudget),
        calibration: calibration(outcomes),
        summary: summarise(outcomes),
        batching: single ? disagreement(batched.verdicts, single.verdicts, threshold) : undefined,
        calls: batched.calls,
        inputTokens: batched.inputTokens,
        costUsd: (batched.inputTokens * info.inputPricePerM) / 1e6,
        medianCallMs: median(batched.latencyMs),
        failures: batched.failures,
        retries: batched.retries + (single?.retries ?? 0),
        warnings: batched.warnings.length,
        // Ids and verdicts only: no message content in saved results.
        verdicts: outcomes.map((o, i) => ({ id: o.fixture.id, label: o.fixture.label, verdict: o.verdict ?? null, single: single?.verdicts.get(`m${i}`) ?? null })),
      });
    }
  }
} finally {
  await dispose();
}

const lines = [];
lines.push(
  `Suite ${SUITE_VERSION} · set ${setName} · ${fixtures.length} fixtures (${count("legitimate")} legitimate, ${count("spam")} spam, ${count("ambiguous")} ambiguous) · BATCH_SIZE ${batchSize} · spam scores ${keepScores ? "kept" : "blanked"} · ${new Date().toISOString().slice(0, 10)}`,
  "",
  `| Model | Question | Fixtures | Important @${threshold} | Worth a look @${threshold} | Promotions @${threshold} | Spam reported @${threshold} (tier) | Tier right | Brier | Invalid | Batching flips | Cost | Median call |`,
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
);
const pctOrDash = (x) => (Number.isNaN(x) ? "—" : pct(x));
for (const r of results) {
  if (r.skipped) {
    lines.push(`| ${r.candidate.name} | ${r.style} | — | — | — | — | — | — | — | — | — | — | skipped: ${r.skipped} |`);
    continue;
  }
  const a = r.at;
  const fpTiers = Object.entries(a.fpByTier).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(", ");
  lines.push(
    `| ${r.candidate.name} | ${r.style} | ${r.fixtures} | ${pctOrDash(a.recallByTier.important)} | ${pctOrDash(a.recallByTier.general)} | ${pctOrDash(a.recallByTier.promotional)} | ${a.fpPer100.toFixed(1)}/100${fpTiers ? ` (${fpTiers})` : ""} | ${r.summary.tierAgreement === null ? "—" : pct(r.summary.tierAgreement)} | ${r.calibration.brier.toFixed(3)} | ${r.summary.invalid} | ${r.batching ? pct(r.batching.reportFlips) : "not run"} | $${r.costUsd.toFixed(5)} | ${r.medianCallMs} ms |`,
  );
}
for (const r of results.filter((r) => !r.skipped)) {
  lines.push("", `${r.candidate.name} · ${r.style}: threshold sweep`, "", "| Threshold | Important | Worth a look | Promotions | Spam reported per 100 (tier shown) | Ambiguous reported |", "|---|---|---|---|---|---|");
  for (const row of r.rows) {
    const fp = Object.entries(row.fpByTier).filter(([, n]) => n).map(([t, n]) => `${n} ${t}`).join(", ");
    lines.push(`| ${row.threshold} | ${pctOrDash(row.recallByTier.important)} | ${pctOrDash(row.recallByTier.general)} | ${pctOrDash(row.recallByTier.promotional)} | ${row.fpPer100.toFixed(1)}${fp ? ` (${fp})` : ""} | ${pct(row.ambiguousReported)} |`);
  }
  lines.push("", `Calibration of P(not spam), n=${r.calibration.n}: ` + r.calibration.buckets.map((b) => `[${b.lo.toFixed(1)}–${b.hi.toFixed(1)}) n=${b.n} said ${b.predicted.toFixed(2)} was ${b.observed.toFixed(2)}`).join(" · "));
  if (r.failures.length) lines.push("", `Failures: ${r.failures.join("; ")}`);
}
const md = lines.join("\n");
console.log(md);
mkdirSync("eval-results", { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(`eval-results/${SUITE_VERSION}-${stamp}.json`, JSON.stringify({ suite: SUITE_VERSION, set: setName, batchSize, threshold, keepScores, results }, null, 2));
writeFileSync(`eval-results/${SUITE_VERSION}-${stamp}.md`, md + "\n");
console.error(`\nsaved eval-results/${SUITE_VERSION}-${stamp}.{json,md}`);
