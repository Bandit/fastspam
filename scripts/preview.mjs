#!/usr/bin/env node
/**
 * Scan your real Spam folder and print what fastspam would report.
 * Sends nothing, writes nothing, moves nothing (the pipeline's readOnly mode).
 *
 *   npm run preview
 *   npm run preview -- --compare-batching   batched vs one question per call
 *   npm run preview -- --label              write eval-private/<date>.json to label
 *   (scripts/build-eval-set.mjs builds larger labelled sets from Spam and Inbox)
 *
 * Needs FASTMAIL_TOKEN in .dev.vars and `npx wrangler login` (for Workers AI).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, flag } from "./env.mjs";

const { run } = await import("../src/pipeline.ts");
const { loadConfig } = await import("../src/config.ts");
const { classify } = await import("../src/ai/classify.ts");
const { disagreement } = await import("../src/eval/score.ts");
const { notSpam } = await import("../src/ai/classifier.ts");

const { env, dispose } = await loadEnv();
try {
  const config = loadConfig(env);
  const report = await run(env, new Date(), { readOnly: true, log: (m) => console.error(`  ${m}`) });
  const { stats, candidates } = report;

  console.log(`\nSpam mailbox: ${report.junkMailbox}`);
  console.log(`Window: since ${stats.since.toISOString()} · ${stats.inWindow} in window · ${stats.fresh} reviewed`);

  // Settle the unknowns the README calls out.
  console.log("\nSpam headers (SPAM_HEADERS):");
  for (const h of config.spamHeaders) {
    const present = candidates.filter((c) => h in c.spamHeaders);
    const sample = present[0]?.spamHeaders[h];
    console.log(`  ${h}: ${present.length}/${candidates.length}${sample ? `  e.g. ${JSON.stringify(sample.slice(0, 80))}` : ""}`);
  }
  const scores = candidates.map((c) => c.spamScore).filter((s) => s !== null).sort((a, b) => a - b);
  if (scores.length) {
    const q = (p) => scores[Math.min(scores.length - 1, Math.floor(p * scores.length))];
    console.log(`  parsed scores: n=${scores.length} min=${scores[0]} p25=${q(0.25)} median=${q(0.5)} p75=${q(0.75)} max=${scores.at(-1)}`);
  } else {
    console.log("  no spam score found in any message: leave SPAM_SCORE_SKIP_ABOVE empty");
  }
  const dmarc = {};
  for (const c of candidates) dmarc[c.auth.dmarc ?? "unknown"] = (dmarc[c.auth.dmarc ?? "unknown"] ?? 0) + 1;
  console.log(`DMARC results: ${JSON.stringify(dmarc)}`);
  console.log(`Sample link (does it open the message?): ${report.sampleLink ?? "(FASTMAIL_LINK_TEMPLATE is empty)"}`);

  console.log(`\nLadder: ${stats.settledByFact} reported on facts · ${stats.droppedByRule} dropped by rules · ${stats.sentToModel} to ${config.aiModel}`);
  const c = report.classification;
  if (c) {
    console.log(`Model: ${c.calls} call(s) · ${c.inputTokens} input tokens · ${c.verdicts.size} valid · ${c.rejected} rejected · ${c.skipped} skipped`);
    for (const w of c.warnings.slice(0, 10)) console.log(`  warning: ${w}`);
  }
  console.log(`Subrequests used: ${report.subrequests} of ${config.subrequestBudget}\n`);
  console.log(report.message ? `${report.message.subject}\n\n${report.message.text}` : "(no digest: nothing to report and SEND_WHEN_EMPTY=false)");

  if (flag("compare-batching") && report.modelItems.length) {
    const items = report.modelItems.map((m) => m.item);
    const opts = { model: config.aiModel, gatewayId: config.aiGatewayId, maxCalls: 10_000, contextTokens: config.modelContextTokens, style: config.questionStyle, concurrency: 8 };
    console.log(`\nComparing batching on ${items.length} message(s)…`);
    const batched = await classify(env.AI, items, { ...opts, batchSize: config.batchSize });
    const single = await classify(env.AI, items, { ...opts, batchSize: 1 });
    const d = disagreement(batched.verdicts, single.verdicts, config.confidenceThreshold);
    console.log(`BATCH_SIZE=${config.batchSize} vs 1: ${d.compared} compared · report decision flips on ${(d.reportFlips * 100).toFixed(1)}% · top answer differs on ${(d.topDiffers * 100).toFixed(1)}% · mean |ΔP(not spam)| ${d.meanAbsDelta.toFixed(3)}`);
    console.log("If report decisions flip on more than a few percent, set BATCH_SIZE lower (1 is always safe).");
  }

  if (flag("label") && report.modelItems.length) {
    // Private: real messages. eval-private/ is gitignored; never commit it.
    mkdirSync("eval-private", { recursive: true });
    const path = `eval-private/preview-${new Date().toISOString().slice(0, 10)}.json`;
    const fixtures = report.modelItems.map((m, i) => {
      const v = report.classification?.verdicts.get(m.item.key);
      return {
        id: `p${i + 1}`,
        label: null,
        hint: v ? `${v.category ?? ""} ${notSpam(v).toFixed(2)} not spam`.trim() : "no verdict",
        message: m.item.message,
      };
    });
    writeFileSync(path, JSON.stringify({ suite: "private", fixtures }, null, 2));
    console.log(`\nWrote ${fixtures.length} message(s) to ${path}. Set each "label" to legitimate, spam or ambiguous, then run npm run evaluate.`);
  }
} finally {
  await dispose();
}
