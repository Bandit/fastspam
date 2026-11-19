#!/usr/bin/env node
/**
 * Scan your real Spam folder and print what fastspam would report.
 * Sends nothing and moves nothing. The deployed Worker does this a slice per
 * run; the preview does every slice at once, against a throwaway local KV.
 *
 *   npm run preview                         the last 14 days of Spam
 *   npm run preview -- --days 30            further back (--days all for everything)
 *   npm run preview -- --compare-batching   batched vs one question per call
 *   npm run preview -- --label              write eval-private/<date>.json to label
 *   (scripts/build-eval-set.mjs builds larger labelled sets from Spam and Inbox)
 *
 * Needs FASTMAIL_TOKEN in .dev.vars and `npx wrangler login` (for Workers AI).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, flag, option } from "./env.mjs";

const { work, digest } = await import("../src/pipeline.ts");
const { loadConfig } = await import("../src/config.ts");
const { classify } = await import("../src/ai/classify.ts");
const { disagreement } = await import("../src/eval/score.ts");
const { notSpam } = await import("../src/ai/classifier.ts");

const { env, dispose } = await loadEnv();
try {
  const days = option("days", "14");
  // All of Sent and the chosen stretch of Spam in one run. The KV from
  // loadEnv() is in memory only, so nothing here touches production state.
  Object.assign(env, { MAX_SLICES_PER_RUN: "1000000", SUBREQUEST_BUDGET: "10000", BACKLOG_DAYS: days === "all" ? "" : days });
  const config = loadConfig(env);
  const now = new Date();
  const report = await work(env, now, { readOnly: true, log: (m) => console.error(`  ${m}`) });
  const digestReport = await digest(env, now, { readOnly: true, log: () => {} });
  const candidates = report.reviewed;

  console.log(`\nSpam mailbox: ${report.junkMailbox}`);
  console.log(`Indexed ${report.sentIndexed} Sent messages · reviewed ${candidates.length} Spam messages (${days === "all" ? "all of Spam" : `last ${days} days`}) in ${report.slices} slices`);
  if (!report.idle) console.log("Stopped before the end: see the problems listed in the digest below.");

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

  console.log(`\nLadder: ${report.settledByFact} reported on facts · ${report.droppedByRule} dropped by rules · ${report.sentToModel} to ${config.aiModel} in ${report.modelCalls} call(s)`);
  for (const w of report.classification?.warnings.slice(0, 10) ?? []) console.log(`  warning: ${w}`);
  console.log(`Subrequests used: ${report.subrequests} (a deployed run is limited to ${loadConfig({ ...env, SUBREQUEST_BUDGET: undefined }).subrequestBudget})\n`);
  const message = digestReport.message;
  console.log(message ? `${message.subject}\n\n${message.text}` : "(no digest: nothing to report and SEND_WHEN_EMPTY=false)");

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
