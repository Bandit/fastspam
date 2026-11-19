import { loadConfig, type Config } from "./config.ts";
import type { Candidate, Env, RescueResult, Suspect } from "./types.ts";
import { DETERMINISTIC_BASES } from "./types.ts";
import { Budget } from "./lib/budget.ts";
import { JmapClient, type FetchImpl } from "./jmap/client.ts";
import { listMailboxes, mailboxPath, resolveMailbox } from "./jmap/mailboxes.ts";
import { fetchCandidates } from "./jmap/spam.ts";
import { threadsWithRealMail } from "./jmap/threads.ts";
import { lookup, updateIndex } from "./jmap/correspondents.ts";
import { rescue } from "./jmap/rescue.ts";
import { decide } from "./decide.ts";
import { classify, type ClassifyResult } from "./ai/classify.ts";
import { isReported, type Item } from "./ai/classifier.ts";
import { promptMessage } from "./ai/prompt.ts";
import { KEYS, pruneReviewed, readJson, writeJson, type CorrespondentIndex, type Reviewed } from "./lib/state.ts";
import { dateFormatter, makeLinker, renderDigest, type RunStats } from "./lib/digest.ts";
import {
  CloudflareEmailNotifier,
  ConsoleNotifier,
  FastmailNotifier,
  PostmarkNotifier,
  type Message,
  type Notifier,
} from "./notify/notifier.ts";

const DAY = 86_400_000;
const MAX_WINDOW_DAYS = 60;

export interface RunOptions {
  fetchImpl?: FetchImpl;
  /** Override the notifier (tests). */
  notifier?: Notifier;
  /**
   * Preview mode: never write KV, never move mail, never send. The rendered
   * digest is returned instead. Used by scripts/preview.mjs.
   */
  readOnly?: boolean;
  log?: (msg: string) => void;
}

export interface RunReport {
  candidates: Candidate[];
  suspects: Suspect[];
  rescue?: RescueResult;
  classification?: ClassifyResult;
  /** What was sent to the model (scripts/preview.mjs uses this to compare batching and build eval sets). */
  modelItems: { candidateId: string; item: Item }[];
  stats: RunStats;
  message: Message | null;
  sent: boolean;
  subrequests: number;
  junkMailbox: string;
  /** FASTMAIL_LINK_TEMPLATE applied to the newest message, so the preview can check it opens. */
  sampleLink?: string;
}

function writeClient(env: Env, config: Config, opts: RunOptions, budget: Budget): JmapClient {
  const token = env.FASTMAIL_WRITE_TOKEN;
  if (typeof token !== "string" || !token || token === "unused") {
    throw new Error("FASTMAIL_WRITE_TOKEN (Email scope) is required for NOTIFIER=fastmail and RESCUE_MAILBOX");
  }
  return new JmapClient({ sessionUrl: config.jmapSessionUrl, token, fetchImpl: opts.fetchImpl, budget });
}

export function makeNotifier(env: Env, config: Config, opts: RunOptions, budget: Budget): Notifier {
  if (opts.notifier) return opts.notifier;
  if (config.dryRun) return new ConsoleNotifier();
  if (config.notifier === "fastmail") {
    return new FastmailNotifier(writeClient(env, config, opts, budget), config.emailFrom, config.emailTo);
  }
  if (!config.emailFrom || !config.emailTo.length) throw new Error("EMAIL_FROM and EMAIL_TO must be set (or set DRY_RUN=true)");
  if (config.notifier === "postmark") {
    const token = env.POSTMARK_SERVER_TOKEN;
    if (typeof token !== "string" || !token || token === "unused") throw new Error("POSTMARK_SERVER_TOKEN secret missing");
    return new PostmarkNotifier(token, config.emailFrom, config.emailTo, config.postmarkStream, opts.fetchImpl);
  }
  if (!env.EMAIL) throw new Error("EMAIL send_email binding missing (or set DRY_RUN=true)");
  return new CloudflareEmailNotifier(env.EMAIL, config.emailFrom, config.emailTo);
}

export async function run(env: Env, now: Date, opts: RunOptions = {}): Promise<RunReport> {
  const config = loadConfig(env);
  const log = opts.log ?? ((m: string) => console.log(m));
  const budget = new Budget(config.subrequestBudget);
  const kv = env.FASTSPAM_STATE;
  const failures: string[] = [];
  const notes: string[] = [];
  const fmt = dateFormatter(config.timezone);

  const token = env.FASTMAIL_TOKEN;
  if (typeof token !== "string" || !token) throw new Error("FASTMAIL_TOKEN secret missing");
  const client = new JmapClient({ sessionUrl: config.jmapSessionUrl, token, fetchImpl: opts.fetchImpl, budget });
  const session = await client.session();
  if (session.accountReadOnly === false) {
    notes.push("FASTMAIL_TOKEN can change mail. fastspam only needs a Read-only access token for scanning.");
  }

  // 1. Mailboxes, resolved once.
  const mailboxes = await listMailboxes(client);
  const junk = resolveMailbox(mailboxes, { label: "Spam", override: config.spamMailbox, role: "junk", names: /^(spam|junk|junk e-?mail|bulk)$/i, required: true })!;
  const sent = resolveMailbox(mailboxes, { label: "Sent", override: config.sentMailbox, role: "sent", names: /^sent( items| messages| mail)?$/i, required: true })!;
  const trash = resolveMailbox(mailboxes, { label: "Trash", role: "trash", names: /^(trash|bin|deleted( items| messages)?)$/i, required: false });
  const rescueBox = config.rescueMailbox
    ? resolveMailbox(mailboxes, { label: "Rescue", override: config.rescueMailbox, required: true })
    : undefined;

  // 2. State.
  const lastRunIso = await readJson<string>(kv, KEYS.lastRun, budget);
  const reviewed = (await readJson<Reviewed>(kv, KEYS.reviewed, budget)) ?? {};
  const previousIndex = await readJson<CorrespondentIndex>(kv, KEYS.correspondents, budget);

  // 3. Correspondent index (a failure here only weakens rung 4; carry on).
  let index = previousIndex;
  try {
    const updated = await updateIndex(client, previousIndex, { sentId: sent.id, bootstrap: config.correspondentBootstrap, max: config.correspondentMax });
    index = updated.index;
    log(`correspondent index: ${Object.keys(index.started).length} started, ${Object.keys(index.addresses).length} written to (${updated.scanned} Sent messages scanned)`);
  } catch (err) {
    failures.push(`could not update the Sent-recipient index: ${errorMessage(err)}`);
  }
  const correspondents = lookup(index);

  // 4. Candidates. The window always covers LOOKBACK_DAYS so anything left
  //    unclassified last time is retried; `reviewed` prevents repeats.
  const lastRun = lastRunIso ? Date.parse(lastRunIso) : NaN;
  const since = new Date(
    Math.max(now.getTime() - MAX_WINDOW_DAYS * DAY, Math.min(now.getTime() - config.lookbackDays * DAY, Number.isFinite(lastRun) ? lastRun - DAY : Infinity)),
  );
  const fetched = await fetchCandidates(client, {
    junkId: junk.id,
    after: since,
    max: config.maxEmailsPerRun,
    spamHeaders: config.spamHeaders,
    previewChars: config.previewChars,
    trustedAuthservIds: config.trustedAuthservIds,
  });
  const fresh = fetched.candidates.filter((c) => !(c.id in reviewed));
  if (fetched.total > fetched.candidates.length) {
    notes.push(`${fetched.total} messages in the window; only the newest ${config.maxEmailsPerRun} (MAX_EMAILS_PER_RUN) were fetched.`);
  }

  // 5. Thread participation.
  let threads = new Set<string>();
  try {
    threads = await threadsWithRealMail(client, fresh.map((c) => c.threadId), {
      exclude: [junk.id, sent.id, ...(trash ? [trash.id] : [])],
      self: correspondents.self,
    });
  } catch (err) {
    failures.push(`could not check conversations: ${errorMessage(err)}`);
  }

  // 6. The ladder.
  const suspects: Suspect[] = [];
  const toModel: { candidate: Candidate; item: Item }[] = [];
  let droppedByRule = 0;
  for (const c of fresh) {
    const d = decide(c, {
      neverReport: config.neverReport,
      alwaysReport: config.alwaysReport,
      spamScoreSkipAbove: config.spamScoreSkipAbove,
      honourDmarcPolicy: config.honourDmarcPolicy,
      correspondents,
      threadsWithRealMail: threads,
      formatDate: fmt,
    });
    if (d.outcome === "drop") droppedByRule++;
    // Facts are always important: you know this sender, or you are in the conversation.
    else if (d.outcome === "report") suspects.push({ candidate: c, basis: d.basis, tier: "important", detail: d.detail });
    else {
      toModel.push({
        candidate: c,
        item: {
          key: `m${toModel.length}`,
          message: promptMessage(c, {
            now,
            domainKnown: correspondents.domain(c.fromEmail),
            repliedBefore: correspondents.repliedOnly(c.fromEmail),
            previewChars: config.previewChars,
          }),
        },
      });
    }
  }
  const settledByFact = suspects.length;

  // 7. The model, for whatever facts could not settle.
  let classification: ClassifyResult | undefined;
  const unclassifiedIds = new Set<string>();
  if (toModel.length) {
    classification = await classify(env.AI, toModel.map((t) => t.item), {
      model: config.aiModel,
      gatewayId: config.aiGatewayId,
      batchSize: config.batchSize,
      maxCalls: config.maxModelCallsPerRun,
      contextTokens: config.modelContextTokens,
      style: config.questionStyle,
      budget,
    });
    failures.push(...classification.failures);
    if (classification.warnings.length) log(`model warnings: ${classification.warnings.slice(0, 20).join("; ")}`);
    for (const t of toModel) {
      const v = classification.verdicts.get(t.item.key);
      if (!v) {
        unclassifiedIds.add(t.candidate.id);
        continue;
      }
      if (isReported(v, config.thresholds) && config.reportTiers.includes(v.tier)) {
        suspects.push({ candidate: t.candidate, basis: "model", tier: v.tier, detail: v.category ?? "legitimate", verdict: v });
      }
    }
  }

  // 8. Optional rescue: facts only, unless RESCUE_BASIS=all.
  let rescueResult: RescueResult | undefined;
  if (rescueBox && !opts.readOnly && !config.dryRun) {
    const eligible = suspects.filter((s) => config.rescueBasis === "all" || DETERMINISTIC_BASES.includes(s.basis)).map((s) => s.candidate.id);
    if (eligible.length) {
      try {
        const writer = writeClient(env, config, opts, budget);
        const writeSession = await writer.session();
        if (writeSession.accountId !== session.accountId) {
          throw new Error("FASTMAIL_WRITE_TOKEN belongs to a different account than FASTMAIL_TOKEN");
        }
        rescueResult = await rescue(writer, eligible, { junkId: junk.id, rescueId: rescueBox.id, max: config.maxRescuesPerRun });
      } catch (err) {
        failures.push(`rescue failed: ${errorMessage(err)}`);
      }
    }
  }

  // 9. Digest.
  const stats: RunStats = {
    inWindow: fetched.total,
    fresh: fresh.length,
    since,
    droppedByRule,
    settledByFact,
    sentToModel: toModel.length,
    classified: classification?.verdicts.size ?? 0,
    unclassified: unclassifiedIds.size,
    modelCalls: classification?.calls ?? 0,
    model: config.aiModel,
    failures,
    notes,
  };
  const linker = makeLinker(config.linkTemplate, { accountId: session.accountId, mailboxId: junk.id, mailboxName: junk.name });
  const message = renderDigest({
    suspects,
    rescue: rescueResult,
    rescueMailboxName: rescueBox ? mailboxPath(rescueBox, mailboxes) : undefined,
    stats,
    now,
    timezone: config.timezone,
    sendWhenEmpty: config.sendWhenEmpty,
    link: linker,
  });

  const report: RunReport = {
    candidates: fresh,
    suspects,
    rescue: rescueResult,
    classification,
    modelItems: toModel.map((t) => ({ candidateId: t.candidate.id, item: t.item })),
    stats,
    message,
    sent: false,
    subrequests: budget.used,
    junkMailbox: mailboxPath(junk, mailboxes),
    sampleLink: fetched.candidates[0] ? linker(fetched.candidates[0]) : undefined,
  };
  if (opts.readOnly) return report;

  // 10. Send, then (and only then) persist. A failed send throws before any
  //     state is written, so next run reports the same messages again.
  if (message) {
    await makeNotifier(env, config, opts, budget).send(message);
    report.sent = true;
  }
  if (config.dryRun) {
    report.subrequests = budget.used;
    return report;
  }
  const nowMs = now.getTime();
  const nextReviewed = pruneReviewed(reviewed, nowMs, config.forgetAfterDays);
  // Unclassified messages are not marked reviewed: they are retried next run.
  for (const c of fresh) if (!unclassifiedIds.has(c.id)) nextReviewed[c.id] = nowMs;
  // Not enforced against the soft budget: the digest is already out, and a
  // refused write here would re-send the same suspects next week.
  await writeJson(kv, KEYS.reviewed, nextReviewed);
  budget.charge();
  if (index && index !== previousIndex) {
    await writeJson(kv, KEYS.correspondents, index);
    budget.charge();
  }
  await writeJson(kv, KEYS.lastRun, now.toISOString());
  budget.charge();
  report.subrequests = budget.used;
  return report;
}

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
