#!/usr/bin/env node
/**
 * Build PRIVATE labelled evaluation sets from your own mail. Read-only: uses
 * FASTMAIL_TOKEN, moves nothing, and never calls a model.
 *
 *   node scripts/build-eval-set.mjs --spam            the last 14 days of Spam (--spam-days N), labelled "spam"
 *   node scripts/build-eval-set.mjs --legit 40 --mailboxes "Inbox,Receipts"
 *                                                     recent mail you KEPT in the mailboxes you
 *                                                     NAME, from senders you never started a
 *                                                     conversation with, one per sender, labelled
 *                                                     "legitimate". There is no default: nothing
 *                                                     outside Spam is read unless you name it.
 *
 * Each file records whether it may be sent to third-party models (Gemini,
 * OpenAI): spam sets yes (production sends them spam anyway), kept-mail sets
 * NO. evaluate.mjs enforces it.
 *
 * Mail is read where it is instead of being moved into Spam, because moving
 * mail into Spam trains Fastmail's filter on it.
 *
 * REVIEW THE FILES before evaluating: spam that reached your Inbox, or real
 * mail sitting in Spam, must be relabelled. Files go to eval-private/, which is
 * gitignored. Never commit them or copy their contents anywhere public.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { loadEnv, flag, option } from "./env.mjs";

const { loadConfig } = await import("../src/config.ts");
const { JmapClient } = await import("../src/jmap/client.ts");
const { listMailboxes, resolveMailbox } = await import("../src/jmap/mailboxes.ts");
const { fetchCandidates, emailProperties, toCandidate } = await import("../src/jmap/spam.ts");
const { applySent, emptyIndex, lookup, SENT_PROPERTIES } = await import("../src/jmap/correspondents.ts");
const { promptMessage } = await import("../src/ai/prompt.ts");

const { env, dispose } = await loadEnv();
try {
  const config = loadConfig(env);
  const client = new JmapClient({ sessionUrl: config.jmapSessionUrl, token: env.FASTMAIL_TOKEN });
  const boxes = await listMailboxes(client);
  const junk = resolveMailbox(boxes, { label: "Spam", override: config.spamMailbox, role: "junk", names: /^(spam|junk)$/i, required: true });
  const sent = resolveMailbox(boxes, { label: "Sent", override: config.sentMailbox, role: "sent", names: /^sent/i, required: true });
  // The whole of Sent, as the deployed Worker indexes it (a page per run there).
  const { ids: sentIds } = await client.queryEmailIds({ inMailbox: sent.id }, 100_000);
  const who = lookup(applySent(emptyIndex(), await client.getMany("Email/get", sentIds, SENT_PROPERTIES), config.correspondentMax));
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const opts = { spamHeaders: config.spamHeaders, previewChars: config.previewChars, trustedAuthservIds: config.trustedAuthservIds };
  const toFixture = (c, i, prefix, label) => ({
    id: `${prefix}${i + 1}`,
    label,
    message: promptMessage(c, { now, domainKnown: who.domain(c.fromEmail), repliedBefore: who.repliedOnly(c.fromEmail), previewChars: config.previewChars }),
  });
  mkdirSync("eval-private", { recursive: true });

  if (flag("spam")) {
    const spamDays = Number(option("spam-days", "14"));
    const { candidates } = await fetchCandidates(client, { ...opts, junkId: junk.id, after: new Date(now.getTime() - spamDays * 864e5), max: 1000 });
    const fixtures = candidates.map((c, i) => toFixture(c, i, "s", "spam"));
    const path = `eval-private/real-spam-${date}.json`;
    writeFileSync(path, JSON.stringify({ suite: "private", external: true, note: "Real Spam, labelled spam. Relabel anything legitimate.", fixtures }, null, 2));
    console.log(`wrote ${fixtures.length} spam fixture(s) to ${path}`);
  }

  const n = Number(option("legit", "0"));
  if (n > 0) {
    // Mail you kept, from cold senders only: mail from people you started
    // conversations with never reaches the model, so it would flatter it.
    const names = option("mailboxes", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (!names.length) throw new Error('--legit needs --mailboxes "Name,Other": name the mailboxes to sample from (nothing outside Spam is read by default)');
    const chosen = names.map((n) => resolveMailbox(boxes, { label: n, override: n, required: true }));
    if (chosen.some((m) => m.id === junk.id || m.id === sent.id)) throw new Error("--mailboxes must not include Spam or Sent");
    const days = Number(option("days", "120"));
    const filter = {
      operator: "AND",
      conditions: [{ operator: "OR", conditions: chosen.map((m) => ({ inMailbox: m.id })) }, { after: new Date(now.getTime() - days * 864e5).toISOString() }],
    };
    const { ids } = await client.queryEmailIds(filter, 2000);
    const rows = await client.getMany("Email/get", ids, emailProperties(opts));
    const seen = new Set();
    const cold = rows
      .map((r) => toCandidate(r, opts))
      .filter((c) => {
        const key = c.fromEmail;
        if (!key || who.isSelf(key) || who.started(key) !== undefined || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    // Spread the sample across the window rather than taking only the newest.
    const step = Math.max(1, cold.length / n);
    const picked = Array.from({ length: Math.min(n, cold.length) }, (_, i) => cold[Math.floor(i * step)]);
    const fixtures = picked.map((c, i) => toFixture(c, i, "l", "legitimate"));
    const path = `eval-private/kept-legit-${date}.json`;
    writeFileSync(path, JSON.stringify({ suite: "private", external: false, note: `Mail you kept in ${names.join(", ")}, from senders you never started a conversation with, one per sender, labelled legitimate. Never sent to third-party models unless evaluate.mjs is run with --allow-external-private <provider>. Relabel any spam as spam, or anything you can't call as ambiguous.`, fixtures }, null, 2));
    console.log(`wrote ${fixtures.length} legitimate fixture(s) to ${path} (${cold.length} cold senders in ${ids.length} kept messages over ${days} days)`);
  }
} finally {
  await dispose();
}
