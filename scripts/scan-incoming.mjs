#!/usr/bin/env node
/**
 * The incoming check (README "Incoming check"), run locally over a window of
 * past mail. Read-only: look for spam that reached folders other than Spam. Facts settle what they can (see src/incoming.ts); the rest
 * goes to AI_MODEL, and a message is flagged when the model puts P(spam) at or
 * above --threshold. Nothing is moved, written or sent.
 *
 *   node scripts/scan-incoming.mjs --mailboxes "Inbox, Lists/Newsletters" --days 14
 *   node scripts/scan-incoming.mjs --set missed     Spam messages with a low spam score: most
 *                                                   likely ones you moved there by hand, i.e.
 *                                                   spam the filter let through. A catch-rate test.
 *
 * Options: --threshold (default INCOMING_THRESHOLD, 0.7), --score-below 5 (for --set missed), --max 1000,
 * --show-near (also list messages just under the threshold), --skip-read (leave
 * out messages already marked read: if you read it and didn't report it as spam
 * yourself, you've judged it. Also INCOMING_SKIP_READ=true).
 *
 * This sends previews of mail OUTSIDE Spam to the model, so it refuses
 * openai/ models (Gemini Decision and the Clef models only). Paths use "/" or ".".
 */
import { loadEnv, flag, option } from "./env.mjs";

const { loadConfig } = await import("../src/config.ts");
const { JmapClient } = await import("../src/jmap/client.ts");
const { listMailboxes, resolveMailbox, mailboxPath } = await import("../src/jmap/mailboxes.ts");
const { emailProperties, toCandidate } = await import("../src/jmap/spam.ts");
const { applySent, emptyIndex, lookup, SENT_PROPERTIES } = await import("../src/jmap/correspondents.ts");
const { threadsWithYourMail } = await import("../src/jmap/threads.ts");
const { FASTSPAM_HEADER } = await import("../src/jmap/append.ts");
const { decideIncoming } = await import("../src/incoming.ts");
const { promptMessage } = await import("../src/ai/prompt.ts");
const { classify } = await import("../src/ai/classify.ts");
const { clean } = await import("../src/lib/sanitise.ts");

const { env, dispose } = await loadEnv();
try {
  const config = loadConfig(env);
  if (config.aiModel.startsWith("openai/")) throw new Error("scan-incoming does not send mail outside Spam to OpenAI; set AI_MODEL to Gemini Decision or a Clef model");
  const threshold = Number(option("threshold", String(config.incomingThreshold)));
  const days = Number(option("days", "14"));
  const max = Number(option("max", "1000"));
  const set = option("set", "mailboxes");
  const now = new Date();

  const client = new JmapClient({ sessionUrl: config.jmapSessionUrl, token: env.FASTMAIL_TOKEN });
  const all = await listMailboxes(client);
  const find = (spec) => {
    try {
      return resolveMailbox(all, { label: spec, override: spec, required: true });
    } catch {
      return resolveMailbox(all, { label: spec, override: spec.replace(/\./g, "/"), required: true });
    }
  };
  const junk = resolveMailbox(all, { label: "Spam", override: config.spamMailbox, role: "junk", required: true });
  const sent = resolveMailbox(all, { label: "Sent", override: config.sentMailbox, role: "sent", required: true });

  let filter;
  let label;
  let scoreBelow = null;
  if (set === "missed") {
    scoreBelow = Number(option("score-below", "5"));
    filter = { inMailbox: junk.id };
    label = `Spam messages scoring below ${scoreBelow} (likely moved there by hand)`;
  } else {
    const names = option("mailboxes", String(env.INCOMING_MAILBOXES ?? ""))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) throw new Error('name the folders to scan: --mailboxes "Inbox, Other/Folder"');
    const boxes = names.map(find);
    if (boxes.some((b) => b.id === junk.id)) throw new Error("scan-incoming is for folders other than Spam; use --set missed for Spam");
    const skipRead = flag("skip-read") || String(env.INCOMING_SKIP_READ ?? "").toLowerCase() === "true";
    filter = {
      operator: "AND",
      conditions: [
        { operator: "OR", conditions: boxes.map((b) => ({ inMailbox: b.id })) },
        { after: new Date(now.getTime() - days * 864e5).toISOString() },
        ...(skipRead ? [{ notKeyword: "$seen" }] : []),
      ],
    };
    label = `${boxes.map((b) => mailboxPath(b, all)).join(", ")}, last ${days} days${skipRead ? ", unread only" : ""}`;
  }

  // The whole Sent index, as the deployed Worker builds it.
  const { ids: sentIds } = await client.queryEmailIds({ inMailbox: sent.id }, 100_000);
  const who = lookup(applySent(emptyIndex(), await client.getMany("Email/get", sentIds, SENT_PROPERTIES), config.correspondentMax));

  const { ids } = await client.queryEmailIds(filter, max);
  const raw = await client.getMany("Email/get", ids, [...emailProperties(config), `header:${FASTSPAM_HEADER}:asText`]);
  let rows = raw.filter((r) => !r[`header:${FASTSPAM_HEADER}:asText`]);
  const ownReports = raw.length - rows.length;
  let candidates = rows.map((r) => toCandidate(r, config));
  if (scoreBelow !== null) candidates = candidates.filter((c) => c.spamScore !== null && c.spamScore < scoreBelow);

  const threads = await threadsWithYourMail(client, candidates.map((c) => c.threadId), { sentId: sent.id, self: who.self });
  const skipped = {};
  const flagged = [];
  const toModel = [];
  for (const c of candidates) {
    const d = decideIncoming(c, {
      alwaysReport: config.alwaysReport,
      neverReport: config.neverReport,
      honourDmarcPolicy: config.honourDmarcPolicy,
      correspondents: who,
      threadsWithYourMail: threads,
    });
    if (d.outcome === "skip") skipped[d.reason] = (skipped[d.reason] ?? 0) + 1;
    else if (d.outcome === "flag") flagged.push({ c, why: d.detail });
    else {
      toModel.push({
        c,
        item: {
          key: `m${toModel.length}`,
          message: promptMessage(c, { now, domainKnown: who.domain(c.fromEmail), repliedBefore: who.repliedOnly(c.fromEmail), previewChars: config.previewChars }),
        },
      });
    }
  }

  const result = toModel.length
    ? await classify(env.AI, toModel.map((t) => t.item), {
        model: config.aiModel,
        gatewayId: config.aiModel.startsWith("@cf/") ? "" : config.aiGatewayId,
        batchSize: config.batchSize,
        maxCalls: 10_000,
        contextTokens: config.modelContextTokens,
        style: "categories",
        concurrency: 4,
        context: "incoming",
      })
    : null;
  const scored = toModel.map((t) => ({ ...t, v: result?.verdicts.get(t.item.key) }));
  const pSpam = (v) => 1 - v.notSpam;
  for (const s of scored) if (s.v && pSpam(s.v) >= threshold) flagged.push({ c: s.c, why: `model: ${Math.round(pSpam(s.v) * 100)}% spam` });

  const line = (c) => `${clean(c.fromName, 40) || "(no name)"} <${clean(c.fromEmail, 60)}> · ${clean(c.subject, 70) || "(no subject)"} · score ${c.spamScore ?? "-"}`;
  console.log(`\n${label}: ${candidates.length} messages${ownReports ? ` (${ownReports} fastspam reports left out)` : ""}`);
  console.log(`Settled by facts: ${Object.entries(skipped).map(([k, n]) => `${n} ${k}`).join(", ") || "none"}`);
  console.log(`Sent to ${config.aiModel}: ${toModel.length} in ${result?.calls ?? 0} call(s)${result?.failures.length ? ` · FAILURES: ${result.failures.join("; ")}` : ""}`);
  const valid = scored.filter((s) => s.v);
  const bucket = (lo, hi) => valid.filter((s) => pSpam(s.v) >= lo && pSpam(s.v) < hi).length;
  console.log(`P(spam) from the model: <0.2 ${bucket(0, 0.2)} · 0.2-0.5 ${bucket(0.2, 0.5)} · 0.5-${threshold} ${bucket(0.5, threshold)} · ≥${threshold} ${bucket(threshold, 1.01)}`);
  console.log(`\nFLAGGED at ${threshold}: ${flagged.length}${set === "missed" ? ` of ${candidates.length} (catch rate ${candidates.length ? Math.round((100 * flagged.length) / candidates.length) : 0}%)` : ""}`);
  for (const f of flagged) console.log(`  • ${line(f.c)}\n      ${f.why}`);
  if (flag("show-near") && set !== "missed") {
    const near = valid.filter((s) => pSpam(s.v) >= 0.5 && pSpam(s.v) < threshold).sort((a, b) => pSpam(b.v) - pSpam(a.v));
    console.log(`\nJust under the threshold (0.5-${threshold}): ${near.length}`);
    for (const s of near) console.log(`  • ${line(s.c)}\n      model: ${Math.round(pSpam(s.v) * 100)}% spam, top answer ${s.v.top ?? "-"}`);
  }
  if (set === "missed") {
    const missed = scored.filter((s) => s.v && pSpam(s.v) < threshold);
    console.log(`\nNot flagged: ${candidates.length - flagged.length}`);
    for (const s of missed.sort((a, b) => pSpam(b.v) - pSpam(a.v))) console.log(`  • ${line(s.c)}\n      model: ${Math.round(pSpam(s.v) * 100)}% spam, top answer ${s.v.top ?? "-"}`);
    const skippedHere = candidates.length - toModel.length - flagged.filter((f) => !f.why.startsWith("model")).length;
    if (skippedHere) console.log(`  (${skippedHere} more were settled by facts as not spam: you know these senders or wrote in the conversation)`);
  }
} finally {
  await dispose();
}
