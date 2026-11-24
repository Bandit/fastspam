import { loadConfig, type Config } from "./config.ts";
import type { Candidate, Env, RescueResult, Suspect } from "./types.ts";
import { DETERMINISTIC_BASES } from "./types.ts";
import { Budget } from "./lib/budget.ts";
import { JmapClient, type FetchImpl, type Session } from "./jmap/client.ts";
import { findMailbox, listMailboxes, mailboxPath, resolveMailbox, type Mailbox } from "./jmap/mailboxes.ts";
import { AUTH, emailProperties, toCandidate } from "./jmap/spam.ts";
import { threadsWithRealMail, threadsWithYourMail } from "./jmap/threads.ts";
import { FASTSPAM_HEADER } from "./jmap/append.ts";
import { decideIncoming } from "./incoming.ts";
import { renderIncomingReport } from "./lib/incoming-report.ts";
import { renderAlert } from "./lib/alert.ts";
import { applySent, emptyIndex, lookup, SENT_PROPERTIES, type SentRow } from "./jmap/correspondents.ts";
import { rescue } from "./jmap/rescue.ts";
import { quarantine } from "./jmap/quarantine.ts";
import { decide } from "./decide.ts";
import { classify, type ClassifyResult } from "./ai/classify.ts";
import { isReported, type Item } from "./ai/classifier.ts";
import { promptMessage } from "./ai/prompt.ts";
import {
  addLines,
  emptyIncomingStats,
  emptyStats,
  KEYS,
  newJob,
  readJson,
  recordFailures,
  upgradeFailures,
  writeJson,
  type CorrespondentIndex,
  type Edge,
  type IncomingFind,
  type IncomingState,
  type JobState,
  type PendingSuspect,
} from "./lib/state.ts";
import { nextSlot, scheduleKey, type DigestSchedule } from "./lib/schedule.ts";
import { dateFormatter, makeLinker, renderDigest, type RunStats } from "./lib/digest.ts";
import {
  CloudflareEmailNotifier,
  ConsoleNotifier,
  FastmailNotifier,
  PostmarkNotifier,
  type Message,
  type Notifier,
} from "./notify/notifier.ts";

/**
 * One cron, every few minutes. Each run either sends the digest (if a digest
 * time has passed since the last one) or does a bounded slice of work:
 *
 *   1. index a page of Sent history, until all of it is indexed; then
 *   2. pick up new Sent mail and review the next slice of Spam, oldest first,
 *      from a saved position, storing finds until the digest.
 *
 * A slice is small enough to fit the Workers Free CPU limit (10 ms), and the
 * same position carries the first pass through a full Spam folder and, once
 * that has caught up, each new message as it arrives.
 */

const MINUTE = 60_000;
const DAY = 86_400_000;
/**
 * Mail newer than this is left for the next run. receivedAt is stamped on
 * arrival, but a message can become visible to queries a little later; without
 * the lag, a late arrival older than the saved position would be skipped.
 */
const SETTLE_MS = 10 * MINUTE;
/**
 * The incoming check waits less: Fastmail filters and files a message before
 * it becomes visible, so this only allows for a slow delivery. It also
 * re-reads INCOMING_LOOKBACK_MS behind its position each run, skipping ids it
 * has checked, so a message that becomes visible later than that is still
 * checked rather than skipped.
 */
const INCOMING_SETTLE_MS = 1 * MINUTE;
const INCOMING_LOOKBACK_MS = 15 * MINUTE;
/** The position is a receivedAt; re-read a second either side of it in case the server's `after` is strict. */
const EDGE_MS = 1000;
/** Subrequests a slice needs beyond the model: one query, two for threads, two KV writes, a rescue. */
const SLICE_RESERVE = 12;
const DIGEST_RETRY_MS = 60 * MINUTE;
const MAX_PENDING = 500;
/** Incoming messages checked per run, and finds kept for the next incoming report. */
const INCOMING_SLICE = 40;
const MAX_INCOMING_PENDING = 100;
/**
 * Once something has been quarantined, the report waits only this long after
 * the last one (or INCOMING_REPORT_MINUTES, if shorter): real mail moved out
 * of your inbox shouldn't stay unmentioned for an hour. MAX_QUARANTINE_PER_DAY
 * bounds how many reports that can cause.
 */
const QUARANTINE_REPORT_MS = 15 * MINUTE;
/**
 * An alert goes out once work runs have kept hitting a problem for this long
 * (and on at least two runs), whatever the cron interval.
 */
const ALERT_AFTER_MS = 45 * MINUTE;
const ALERT_MIN_RUNS = 2;
/** While the problem lasts, the alert repeats at most this often. */
const ALERT_REPEAT_MS = 24 * 60 * MINUTE;
/** A full pass of the Spam sweep starts at most this often. */
const SWEEP_EVERY_MS = 6 * 60 * MINUTE;
/** How often to check whether all of Spam is marked read (for SPAM_SKIP_READ). */
const AUTO_READ_CHECK_MS = 6 * 60 * MINUTE;
/**
 * A learned sender whose mail is no longer in Spam is forgotten if that mail
 * arrived within this many days: too recent for Spam's automatic deletion, so
 * you probably moved it back out. Older ones were most likely purged, and are
 * kept for SPAM_SENDER_KEEP_MS.
 */
const SPAM_SENDER_RECENT_MS = 20 * DAY;
const SPAM_SENDER_KEEP_MS = 365 * DAY;
const MAX_SPAM_SENDERS = 5000;

export interface RunOptions {
  fetchImpl?: FetchImpl;
  /** Override the notifier (tests). */
  notifier?: Notifier;
  /**
   * Never send a digest or move mail. State is still written, so pass a
   * throwaway KV (scripts/preview.mjs does).
   */
  readOnly?: boolean;
  log?: (msg: string) => void;
}

export interface WorkReport {
  kind: "work";
  slices: number;
  /** Sent messages folded into the index this run. */
  sentIndexed: number;
  /** Spam messages reviewed this run. */
  reviewed: Candidate[];
  /** Finds this run (also added to the pending list). */
  suspects: Suspect[];
  droppedByRule: number;
  settledByFact: number;
  sentToModel: number;
  modelCalls: number;
  classification?: ClassifyResult;
  /** What was sent to the model (scripts/preview.mjs compares batching and builds eval sets from it). */
  modelItems: { candidateId: string; item: Item }[];
  rescue?: RescueResult;
  failures: string[];
  /** Nothing left to do right now. */
  idle: boolean;
  subrequests: number;
  junkMailbox: string;
  /** FASTMAIL_LINK_TEMPLATE applied to a reviewed message, so the preview can check it opens. */
  sampleLink?: string;
  /** The incoming check, when INCOMING_MAILBOXES is set and it ran. */
  incoming?: { checked: number; settledByFact: number; sentToModel: number; modelCalls: number; flagged: number; quarantined: number };
}

export interface DigestReport {
  kind: "digest";
  message: Message | null;
  sent: boolean;
  stats: RunStats;
  listed: number;
  subrequests: number;
}

export interface IncomingReport {
  kind: "incoming-report";
  message: Message | null;
  sent: boolean;
  listed: number;
  /** Finds left out because you had already moved, deleted or read them. */
  dealtWith: number;
  subrequests: number;
}

export interface AlertReport {
  kind: "alert";
  message: Message;
  sent: boolean;
  runs: number;
  subrequests: number;
}

export type RunReport = WorkReport | DigestReport | IncomingReport | AlertReport;

interface Context {
  env: Env;
  config: Config;
  budget: Budget;
  kv: KVNamespace;
  client: JmapClient;
  opts: RunOptions;
  log: (msg: string) => void;
}

function context(env: Env, opts: RunOptions): Context {
  const config = loadConfig(env);
  const budget = new Budget(config.subrequestBudget);
  const token = env.FASTMAIL_TOKEN;
  if (typeof token !== "string" || !token) throw new Error("FASTMAIL_TOKEN secret missing");
  return {
    env,
    config,
    budget,
    kv: env.FASTSPAM_STATE,
    client: new JmapClient({ sessionUrl: config.jmapSessionUrl, token, fetchImpl: opts.fetchImpl, budget }),
    opts,
    log: opts.log ?? ((m: string) => console.log(m)),
  };
}

async function loadJob(ctx: Context, now: Date): Promise<JobState> {
  const job = await readJson<JobState>(ctx.kv, KEYS.job, ctx.budget);
  if (job?.v !== 1) return newJob(now);
  job.stats.failures = upgradeFailures(job.stats.failures);
  return job;
}

function digestSchedule(config: Config): DigestSchedule {
  return { days: config.digestDays, hour: config.digestHour, timezone: config.timezone };
}

/** Work out when the next digest is due after `from`, and record it in the job. */
function planNextDigest(job: JobState, config: Config, from: number): void {
  const schedule = digestSchedule(config);
  const next = nextSlot(from, schedule);
  job.nextDigestAt = next === null ? undefined : new Date(next).toISOString();
  job.scheduleKey = scheduleKey(schedule);
}

/**
 * Whether this run should send the digest rather than work. Updates the job's
 * stored next-digest time if the schedule settings changed (returns
 * `planned: true` so the job is saved).
 */
export function digestTiming(job: JobState, config: Config, now: Date): { due: boolean; planned: boolean } {
  let planned = false;
  if (job.scheduleKey !== scheduleKey(digestSchedule(config)) || !job.nextDigestAt) {
    planNextDigest(job, config, Date.parse(job.lastDigestAt));
    planned = true;
  }
  const failedAt = job.digestFailedAt ? Date.parse(job.digestFailedAt) : NaN;
  if (Number.isFinite(failedAt) && now.getTime() - failedAt < DIGEST_RETRY_MS) return { due: false, planned };
  return { due: !!job.nextDigestAt && Date.parse(job.nextDigestAt) <= now.getTime(), planned };
}

/**
 * Whether this run should send the incoming report: something was found, and
 * the last report (if any) was at least INCOMING_REPORT_MINUTES ago, or
 * QUARANTINE_REPORT_MS if something has been quarantined.
 */
export function incomingReportDue(job: JobState, config: Config, now: Date): boolean {
  const inc = job.incoming;
  if (!config.incomingMailboxes.length || !inc?.pending.length) return false;
  const failedAt = inc.reportFailedAt ? Date.parse(inc.reportFailedAt) : NaN;
  if (Number.isFinite(failedAt) && now.getTime() - failedAt < DIGEST_RETRY_MS) return false;
  const wait = config.incomingReportMinutes * MINUTE;
  const gap = inc.pending.some((p) => p.movedTo) ? Math.min(wait, QUARANTINE_REPORT_MS) : wait;
  return !inc.lastReportAt || now.getTime() - Date.parse(inc.lastReportAt) >= gap;
}

/** Whether work runs have kept failing long enough to alert, and no alert went out for it today. */
export function alertDue(job: JobState, now: Date): boolean {
  const streak = job.failStreak;
  if (!streak || streak.runs < ALERT_MIN_RUNS || now.getTime() - Date.parse(streak.since) < ALERT_AFTER_MS) return false;
  return !streak.alertedAt || now.getTime() - Date.parse(streak.alertedAt) >= ALERT_REPEAT_MS;
}

/**
 * The scheduled entry point, one thing per run: the weekly digest if due, else
 * an alert about repeated failures, else the incoming report, else work.
 */
export async function run(env: Env, now: Date, opts: RunOptions = {}): Promise<RunReport> {
  const ctx = context(env, opts);
  const job = await loadJob(ctx, now);
  const { due, planned } = digestTiming(job, ctx.config, now);
  if (due) return sendDigest(ctx, job, now);
  if (alertDue(job, now)) return sendAlert(ctx, job, now);
  if (incomingReportDue(job, ctx.config, now)) return sendIncomingReport(ctx, job, now);
  return doWork(ctx, job, now, planned);
}

/** Work only (the preview script loops this). */
export async function work(env: Env, now: Date, opts: RunOptions = {}): Promise<WorkReport> {
  const ctx = context(env, opts);
  return doWork(ctx, await loadJob(ctx, now), now);
}

/** The digest only, whether or not one is due (the preview script uses this). */
export async function digest(env: Env, now: Date, opts: RunOptions = {}): Promise<DigestReport> {
  const ctx = context(env, opts);
  return sendDigest(ctx, await loadJob(ctx, now), now);
}

interface Boxes {
  session: Session;
  mailboxes: Mailbox[];
  junk: Mailbox;
  sent: Mailbox;
  trash?: Mailbox;
  rescueBox?: Mailbox;
}

async function boxes(ctx: Context): Promise<Boxes> {
  const session = await ctx.client.session();
  const mailboxes = await listMailboxes(ctx.client);
  const { config } = ctx;
  return {
    session,
    mailboxes,
    junk: resolveMailbox(mailboxes, { label: "Spam", override: config.spamMailbox, role: "junk", names: /^(spam|junk|junk e-?mail|bulk)$/i, required: true })!,
    sent: resolveMailbox(mailboxes, { label: "Sent", override: config.sentMailbox, role: "sent", names: /^sent( items| messages| mail)?$/i, required: true })!,
    trash: resolveMailbox(mailboxes, { label: "Trash", role: "trash", names: /^(trash|bin|deleted( items| messages)?)$/i, required: false }),
    rescueBox: config.rescueMailbox ? resolveMailbox(mailboxes, { label: "Rescue", override: config.rescueMailbox, required: true }) : undefined,
  };
}

// ---------------------------------------------------------------- positions

/**
 * Move a position past `rows` (processed, oldest first). The edge keeps the ids
 * within a second of the position, which the next query re-reads.
 */
export function advance(rows: { id: string; receivedAt: string }[], cursor: string | undefined, edge: Edge[]): { cursor: string | undefined; edge: Edge[] } {
  const last = rows.at(-1);
  if (!last) return { cursor, edge };
  const floor = Date.parse(last.receivedAt) - EDGE_MS;
  const next = [...edge, ...rows.map((r) => ({ id: r.id, at: r.receivedAt }))].filter((e) => Date.parse(e.at) >= floor);
  const seen = new Set<string>();
  return { cursor: last.receivedAt, edge: next.filter((e) => !seen.has(e.id) && (seen.add(e.id), true)) };
}

function afterFilter(cursor: string | undefined): string | undefined {
  return cursor ? new Date(Date.parse(cursor) - EDGE_MS).toISOString() : undefined;
}

// ---------------------------------------------------------------- work

async function doWork(ctx: Context, saved: JobState, now: Date, dirty = false): Promise<WorkReport> {
  // Work on a copy: if anything throws, only the failure is recorded.
  const job = structuredClone(saved);
  try {
    return await workSlices(ctx, job, now, dirty);
  } catch (err) {
    if (!ctx.opts.readOnly) {
      recordFailures(saved.stats.failures, [errorMessage(err)], now);
      countFailedRun(saved, true, now);
      try {
        await writeJson(ctx.kv, KEYS.job, saved);
      } catch {
        // The original error matters more.
      }
    }
    throw err;
  }
}

async function workSlices(ctx: Context, job: JobState, now: Date, dirty: boolean): Promise<WorkReport> {
  const { config, client, budget, log } = ctx;
  const b = await boxes(ctx);
  const { session, junk, sent } = b;
  if (session.accountReadOnly === false) {
    addLines(job.stats.notes, ["FASTMAIL_TOKEN can change mail. fastspam only needs a Read-only access token for scanning."]);
  }
  const settled = new Date(now.getTime() - SETTLE_MS).toISOString();
  const linesBefore = job.stats.notes.length;
  const report: WorkReport = {
    kind: "work",
    slices: 0,
    sentIndexed: 0,
    reviewed: [],
    suspects: [],
    droppedByRule: 0,
    settledByFact: 0,
    sentToModel: 0,
    modelCalls: 0,
    modelItems: [],
    failures: [],
    idle: false,
    subrequests: 0,
    junkMailbox: mailboxPath(junk, b.mailboxes),
  };
  const linker = makeLinker(config.linkTemplate, { accountId: session.accountId, mailboxId: junk.id, mailboxName: junk.name });
  let index: CorrespondentIndex | undefined;
  let indexChanged = false;
  let jobChanged = dirty;
  const loadIndex = async () => {
    if (!index) {
      const stored = await readJson<CorrespondentIndex>(ctx.kv, KEYS.index, budget);
      // A fresh job rebuilds the index from scratch.
      index = stored?.v === 3 && job.sent.historyIndexed > 0 ? stored : emptyIndex();
    }
    return index;
  };

  // SPAM_SKIP_READ means nothing if Fastmail marks all spam read; check now and then.
  if (config.spamSkipRead && job.sent.historyComplete) {
    try {
      if (await checkAutoRead(ctx, job, b, now)) jobChanged = true;
    } catch (err) {
      report.failures.push(`could not check whether Spam is marked read: ${errorMessage(err)}`);
    }
  }

  // The incoming check first: it's the time-sensitive part. A failure here is
  // recorded and doesn't hold up the Spam review.
  if (config.incomingMailboxes.length && job.sent.historyComplete) {
    try {
      if (await checkIncoming(ctx, job, b, now, report, loadIndex)) jobChanged = true;
    } catch (err) {
      report.failures.push(`incoming check failed: ${errorMessage(err)}`);
    }
  }

  while (report.slices < config.maxSlicesPerRun && budget.remaining >= SLICE_RESERVE) {
    report.slices++;

    // 1. Sent history, newest first, a page per slice. Spam waits for it: a
    //    message reviewed before the index is complete would miss its facts.
    if (!job.sent.historyComplete) {
      job.sent.historyBefore ??= settled;
      job.sent.newFrom ??= job.sent.historyBefore;
      const res = await client.request([
        [
          "Email/query",
          {
            accountId: session.accountId,
            filter: { inMailbox: sent.id, before: job.sent.historyBefore },
            sort: [{ property: "receivedAt", isAscending: false }],
            position: job.sent.historyIndexed,
            limit: config.sentPage,
            calculateTotal: true,
          },
          "q",
        ],
        ["Email/get", { accountId: session.accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties: SENT_PROPERTIES }, "g"],
      ]);
      const ids = (res.get("q")?.ids as string[] | undefined) ?? [];
      const total = res.get("q")?.total;
      const rows = (res.get("g")?.list as SentRow[] | undefined) ?? [];
      applySent(await loadIndex(), rows, config.correspondentMax);
      job.sent.historyIndexed += ids.length;
      if (typeof total === "number") job.sent.historyTotal = total;
      if (ids.length < config.sentPage) job.sent.historyComplete = true;
      report.sentIndexed += rows.length;
      indexChanged = jobChanged = true;
      log(`indexed ${rows.length} Sent messages (${job.sent.historyIndexed}${job.sent.historyTotal !== undefined ? ` of ${job.sent.historyTotal}` : ""})`);
      continue;
    }

    // 2. New Sent mail and the next slice of Spam, in one request. New Sent is
    //    applied first: you may have just written to someone whose reply is in Spam.
    const spamEdge = job.spam.edge;
    const spamLimit = config.spamSlice + spamEdge.length;
    const spamAfter =
      afterFilter(job.spam.cursor) ?? (config.backlogDays !== null ? new Date(now.getTime() - config.backlogDays * DAY).toISOString() : undefined);
    const sentEdge = job.sent.newEdge;
    const res = await client.request([
      [
        "Email/query",
        {
          accountId: session.accountId,
          filter: { inMailbox: sent.id, after: afterFilter(job.sent.newFrom), before: settled },
          sort: [{ property: "receivedAt", isAscending: true }],
          limit: config.sentPage + sentEdge.length,
        },
        "sq",
      ],
      ["Email/get", { accountId: session.accountId, "#ids": { resultOf: "sq", name: "Email/query", path: "/ids" }, properties: [...SENT_PROPERTIES] }, "sg"],
      [
        "Email/query",
        {
          accountId: session.accountId,
          filter: { inMailbox: junk.id, ...(spamAfter ? { after: spamAfter } : {}), before: settled },
          sort: [{ property: "receivedAt", isAscending: true }],
          limit: spamLimit,
        },
        "jq",
      ],
      [
        "Email/get",
        {
          accountId: session.accountId,
          "#ids": { resultOf: "jq", name: "Email/query", path: "/ids" },
          properties: emailProperties({ spamHeaders: config.spamHeaders, previewChars: config.previewChars }),
        },
        "jg",
      ],
    ]);

    const sentRows = byQueryOrder(res.get("sq")?.ids, res.get("sg")?.list) as unknown as (SentRow & { id: string; receivedAt: string })[];
    const sentSeen = new Set(sentEdge.map((e) => e.id));
    const newSent = sentRows.filter((r) => !sentSeen.has(r.id));
    if (newSent.length) {
      applySent(await loadIndex(), newSent, config.correspondentMax);
      const moved = advance(newSent, job.sent.newFrom, sentEdge);
      job.sent.newFrom = moved.cursor;
      job.sent.newEdge = moved.edge;
      report.sentIndexed += newSent.length;
      indexChanged = jobChanged = true;
    }

    const spamIds = (res.get("jq")?.ids as string[] | undefined) ?? [];
    const edgeIds = new Set(spamEdge.map((e) => e.id));
    const rows = byQueryOrder(spamIds, res.get("jg")?.list).filter((r) => !edgeIds.has(String(r.id)));
    const reachedEnd = spamIds.length < spamLimit;
    if (!rows.length) {
      if (reachedEnd && !job.spam.caughtUpAt) {
        job.spam.caughtUpAt = now.toISOString();
        jobChanged = true;
      }
      report.idle = !newSent.length;
      break;
    }

    const candidates = rows.map((r) => toCandidate(r, config));
    const processed = await reviewSlice(ctx, job, b, candidates, await loadIndex(), now, report);
    const moved = advance(processed, job.spam.cursor, spamEdge);
    job.spam.cursor = moved.cursor;
    job.spam.edge = moved.edge;
    jobChanged = true;
    report.sampleLink ??= candidates[0] ? linker(candidates[0]) : undefined;
    if (processed.length < candidates.length) break; // the model couldn't finish; retry from here next run
    if (reachedEnd) {
      job.spam.caughtUpAt ??= now.toISOString();
      report.idle = true;
      break;
    }
  }

  // On an otherwise quiet run, a page of the sweep that learns who you've moved to Spam.
  if (report.idle && config.learnSpamSenders && config.spamFilterThreshold > 0 && budget.remaining >= SLICE_RESERVE) {
    try {
      const swept = await sweepSpam(ctx, job, b, now, loadIndex);
      if (swept.job) jobChanged = true;
      if (swept.index) indexChanged = true;
    } catch (err) {
      report.failures.push(`learning from Spam failed: ${errorMessage(err)}`);
    }
  }

  recordFailures(job.stats.failures, report.failures, now);
  jobChanged ||= report.failures.length > 0 || job.stats.notes.length !== linesBefore;
  if (countFailedRun(job, report.failures.length > 0, now)) jobChanged = true;
  // Index first, job second: if the job write is lost, the next run redoes the
  // same Sent page, which is harmless. Not enforced against the soft budget:
  // the work is done, and a refused write would only repeat it.
  if (indexChanged && index) {
    await writeJson(ctx.kv, KEYS.index, index);
    budget.charge();
  }
  if (jobChanged) {
    await writeJson(ctx.kv, KEYS.job, job);
    budget.charge();
  }
  report.subrequests = budget.used;
  return report;
}

/** Email/get returns objects in any order; put them back in the query's order. */
function byQueryOrder(ids: unknown, list: unknown): Record<string, unknown>[] {
  const byId = new Map(((list as Record<string, unknown>[] | undefined) ?? []).map((r) => [String(r.id), r]));
  return ((ids as string[] | undefined) ?? []).map((id) => byId.get(id)).filter((r): r is Record<string, unknown> => !!r);
}

/**
 * Review one slice of Spam: rules, facts, then the model. Returns the prefix
 * of `candidates` that was fully reviewed: if the model couldn't answer about
 * a message, it and everything after it are left for the next run.
 */
async function reviewSlice(
  ctx: Context,
  job: JobState,
  b: Boxes,
  candidates: Candidate[],
  index: CorrespondentIndex,
  now: Date,
  report: WorkReport,
): Promise<Candidate[]> {
  const { config, client, budget, env } = ctx;
  const correspondents = lookup(index);
  const fmt = dateFormatter(config.timezone);

  let threads = new Set<string>();
  try {
    threads = await threadsWithRealMail(client, candidates.map((c) => c.threadId), {
      exclude: [b.junk.id, b.sent.id, ...(b.trash ? [b.trash.id] : [])],
      self: correspondents.self,
    });
  } catch (err) {
    report.failures.push(`could not check conversations: ${errorMessage(err)}`);
  }

  const found = new Map<string, Suspect>();
  const toModel: { candidate: Candidate; item: Item }[] = [];
  for (const c of candidates) {
    const d = decide(c, {
      spamSenders: config.spamSenders,
      trustedSenders: config.trustedSenders,
      spamScoreSkipAbove: config.spamScoreSkipAbove,
      spamFilterThreshold: config.spamFilterThreshold,
      skipRead: config.spamSkipRead && !job.spam.autoRead,
      honourDmarcPolicy: config.honourDmarcPolicy,
      correspondents,
      threadsWithRealMail: threads,
      formatDate: fmt,
    });
    if (d.outcome === "drop") continue;
    // Facts are always important: you know this sender, or you are in the conversation.
    else if (d.outcome === "report") found.set(c.id, { candidate: c, basis: d.basis, tier: "important", detail: d.detail });
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

  const unanswered = new Set<string>();
  let calls = 0;
  if (toModel.length) {
    const classification = await classify(env.AI, toModel.map((t) => t.item), {
      model: config.aiModel,
      gatewayId: config.aiGatewayId,
      batchSize: config.batchSize,
      maxCalls: config.maxModelCallsPerRun,
      contextTokens: config.modelContextTokens,
      style: config.questionStyle,
      budget,
    });
    report.classification = classification;
    calls = classification.calls;
    report.modelCalls += calls;
    report.failures.push(...classification.failures);
    if (classification.warnings.length) ctx.log(`model warnings: ${classification.warnings.slice(0, 20).join("; ")}`);
    for (const t of toModel) {
      report.modelItems.push({ candidateId: t.candidate.id, item: t.item });
      const v = classification.verdicts.get(t.item.key);
      if (!v) unanswered.add(t.candidate.id);
      else if (isReported(v, config.thresholds) && config.reportTiers.includes(v.tier)) {
        found.set(t.candidate.id, { candidate: t.candidate, basis: "model", tier: v.tier, detail: v.category ?? "legitimate", verdict: v });
      }
    }
  }

  // Only the prefix before the first unanswered message counts as reviewed.
  const firstGap = candidates.findIndex((c) => unanswered.has(c.id));
  const processed = firstGap < 0 ? candidates : candidates.slice(0, firstGap);
  const done = new Set(processed.map((c) => c.id));
  const suspects = [...found.values()].filter((s) => done.has(s.candidate.id));

  // Tallies for the processed prefix only: the rest is reviewed again next run.
  const inPrefix = (c: Candidate) => done.has(c.id);
  const settledByFact = suspects.filter((s) => s.basis !== "model").length;
  const sentToModel = toModel.filter((t) => inPrefix(t.candidate)).length;
  const droppedHere = processed.length - settledByFact - sentToModel;
  report.reviewed.push(...processed);
  report.suspects.push(...suspects);
  report.droppedByRule += droppedHere;
  report.settledByFact += settledByFact;
  report.sentToModel += sentToModel;
  job.stats.reviewed += processed.length;
  job.stats.droppedByRule += droppedHere;
  job.stats.settledByFact += settledByFact;
  job.stats.sentToModel += sentToModel;
  job.stats.modelCalls += calls;

  // Optional rescue, as each slice is reviewed: facts only, unless RESCUE_BASIS=all.
  const movedIds = new Set<string>();
  if (b.rescueBox && !ctx.opts.readOnly && !config.dryRun) {
    const eligible = suspects.filter((s) => config.rescueBasis === "all" || DETERMINISTIC_BASES.includes(s.basis)).map((s) => s.candidate.id);
    const allowance = Math.max(0, config.maxRescuesPerDigest - job.rescuedThisPeriod);
    if (eligible.length) {
      try {
        const writer = writeClient(env, config, ctx.opts, budget);
        const writeSession = await writer.session();
        if (writeSession.accountId !== b.session.accountId) {
          throw new Error("FASTMAIL_WRITE_TOKEN belongs to a different account than FASTMAIL_TOKEN");
        }
        const result = await rescue(writer, eligible, { junkId: b.junk.id, rescueId: b.rescueBox.id, max: allowance });
        report.rescue = result;
        for (const id of result.moved) movedIds.add(id);
        job.rescuedThisPeriod += result.moved.length;
        for (const k of result.skipped) if (job.rescueSkipped.length < 50) job.rescueSkipped.push(k);
      } catch (err) {
        report.failures.push(`rescue failed: ${errorMessage(err)}`);
      }
    }
  }

  const pendingIds = new Set(job.pending.map((p) => p.candidate.id));
  for (const s of suspects) {
    if (pendingIds.has(s.candidate.id)) continue;
    if (job.pending.length >= MAX_PENDING) {
      addLines(job.stats.notes, [`More than ${MAX_PENDING} finds since the last digest; the rest are not listed.`]);
      break;
    }
    job.pending.push(toPending(s, movedIds.has(s.candidate.id)));
  }
  return processed;
}

function toPending(s: Suspect, moved: boolean): PendingSuspect {
  const c = s.candidate;
  const p: PendingSuspect = {
    candidate: { id: c.id, threadId: c.threadId, fromName: c.fromName, fromEmail: c.fromEmail, subject: c.subject, receivedAt: c.receivedAt },
    basis: s.basis,
    tier: s.tier,
    detail: s.detail,
  };
  if (s.verdict) p.verdict = { notSpam: s.verdict.notSpam, tier: s.verdict.tier, category: s.verdict.category, top: s.verdict.top };
  if (moved) p.moved = true;
  return p;
}

// ---------------------------------------------------------------- learning from Spam

/**
 * Whether Spam is marked read wholesale (Fastmail's "Mark spam as read"), in
 * which case SPAM_SKIP_READ would drop everything and is ignored. Two counts,
 * at most every few hours. Returns whether the job changed.
 */
async function checkAutoRead(ctx: Context, job: JobState, b: Boxes, now: Date): Promise<boolean> {
  const checked = job.spam.autoReadCheckedAt ? Date.parse(job.spam.autoReadCheckedAt) : NaN;
  if (Number.isFinite(checked) && now.getTime() - checked < AUTO_READ_CHECK_MS) return false;
  const { accountId } = b.session;
  const res = await ctx.client.request([
    ["Email/query", { accountId, filter: { inMailbox: b.junk.id }, limit: 0, calculateTotal: true }, "all"],
    ["Email/query", { accountId, filter: { inMailbox: b.junk.id, hasKeyword: "$seen" }, limit: 0, calculateTotal: true }, "read"],
  ]);
  const total = Number(res.get("all")?.total ?? 0);
  const read = Number(res.get("read")?.total ?? 0);
  job.spam.autoReadCheckedAt = now.toISOString();
  // Too little to tell: keep what we thought.
  if (total >= 20) {
    const auto = read / total >= 0.5;
    if (auto && !job.spam.autoRead) {
      addLines(job.stats.notes, [`SPAM_SKIP_READ is being ignored: ${read} of ${total} messages in Spam are marked read, so Fastmail's "Mark spam as read" looks to be on.`]);
    }
    job.spam.autoRead = auto;
  }
  return true;
}

/**
 * Learn who you've moved to Spam yourself: a page of Spam per idle run,
 * looking only at sender, score and authentication. A message scoring below
 * SPAM_FILTER_THRESHOLD got there by your hand (or your rules), and its sender
 * (unless DMARC says the From is forged) joins index.movedToSpam. Mail you
 * move to Spam keeps its original arrival time, so the Spam review, which
 * moves forward by arrival time, never sees it; this sweep does.
 *
 * At the end of each full pass, senders no longer seen are forgotten if their
 * mail was recent (you probably moved it back out), and kept for a year
 * otherwise (it was probably deleted with the rest of Spam).
 */
async function sweepSpam(
  ctx: Context,
  job: JobState,
  b: Boxes,
  now: Date,
  loadIndex: () => Promise<CorrespondentIndex>,
): Promise<{ job: boolean; index: boolean }> {
  const { config, client } = ctx;
  const prev = job.sweep;
  // Between passes: wait SWEEP_EVERY_MS after the last one finished.
  if (prev?.position === 0 && prev.lastCompleteAt && now.getTime() - Date.parse(prev.lastCompleteAt) < SWEEP_EVERY_MS) {
    return { job: false, index: false };
  }
  if (!prev || prev.position === 0) {
    job.sweep = { position: 0, loopStartedAt: now.toISOString(), ...(prev?.lastCompleteAt ? { lastCompleteAt: prev.lastCompleteAt } : {}) };
  }
  const sw = job.sweep!;
  const { accountId } = b.session;
  const res = await client.request([
    [
      "Email/query",
      { accountId, filter: { inMailbox: b.junk.id }, sort: [{ property: "receivedAt", isAscending: true }], position: sw.position, limit: config.sentPage },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "from", "receivedAt", AUTH, ...emailProperties({ spamHeaders: config.spamHeaders, previewChars: 0 }).filter((p) => p.startsWith("header:") && p !== AUTH)],
      },
      "g",
    ],
  ]);
  const ids = (res.get("q")?.ids as string[] | undefined) ?? [];
  const rows = byQueryOrder(ids, res.get("g")?.list);
  const index = await loadIndex();
  const self = new Set(index.self);
  const learned = (index.movedToSpam ??= {});
  const loopStart = Date.parse(sw.loopStartedAt);
  let indexChanged = false;
  for (const r of rows) {
    const c = toCandidate(r, config);
    if (!c.fromEmail || self.has(c.fromEmail) || c.auth.dmarc === "fail") continue;
    if (c.spamScore === null || c.spamScore >= config.spamFilterThreshold) continue;
    const received = Date.parse(c.receivedAt) || now.getTime();
    const known = learned[c.fromEmail];
    learned[c.fromEmail] = { seen: now.getTime(), received: Math.max(known?.received ?? 0, received) };
    indexChanged = true;
  }
  sw.position += ids.length;
  if (ids.length < config.sentPage) {
    // A full pass: forget senders not seen in it whose mail was recent, or very old.
    for (const [addr, e] of Object.entries(learned)) {
      if (e.seen >= loopStart) continue;
      if (now.getTime() - e.received < SPAM_SENDER_RECENT_MS || now.getTime() - e.seen > SPAM_SENDER_KEEP_MS) {
        delete learned[addr];
        indexChanged = true;
      }
    }
    const entries = Object.entries(learned);
    if (entries.length > MAX_SPAM_SENDERS) {
      index.movedToSpam = Object.fromEntries(entries.sort((x, y) => y[1].seen - x[1].seen).slice(0, MAX_SPAM_SENDERS));
      indexChanged = true;
    }
    sw.position = 0;
    sw.lastCompleteAt = now.toISOString();
  }
  return { job: true, index: indexChanged };
}

// ---------------------------------------------------------------- digest

async function sendDigest(ctx: Context, job: JobState, now: Date): Promise<DigestReport> {
  const { config, client, budget } = ctx;
  const b = await boxes(ctx);
  const { session, junk } = b;

  // Drop finds that have already left Spam (you rescued them, or they were purged).
  let pending = job.pending;
  const check = pending.filter((p) => !p.moved).map((p) => p.candidate.id);
  let leftSpam = 0;
  let readInSpam = 0;
  if (check.length) {
    const current = (await client.getMany("Email/get", check, ["id", "mailboxIds", "keywords"])) as {
      id: string;
      mailboxIds?: Record<string, boolean>;
      keywords?: Record<string, boolean>;
    }[];
    const stillIn = new Set(current.filter((e) => e.mailboxIds?.[junk.id]).map((e) => e.id));
    // With SPAM_SKIP_READ, a find you've read and left in Spam is one you've judged.
    const skipRead = config.spamSkipRead && !job.spam.autoRead;
    const read = new Set(skipRead ? current.filter((e) => e.keywords?.$seen).map((e) => e.id) : []);
    pending = pending.filter((p) => p.moved || stillIn.has(p.candidate.id));
    leftSpam = job.pending.length - pending.length;
    const before = pending.length;
    pending = pending.filter((p) => p.moved || !read.has(p.candidate.id));
    readInSpam = before - pending.length;
  }

  // Progress, while the first passes are still running.
  let backlog: RunStats["backlog"];
  if (job.sent.historyComplete && !job.spam.caughtUpAt) {
    let remaining: number | null = null;
    try {
      const res = await client.request([
        [
          "Email/query",
          { accountId: session.accountId, filter: { inMailbox: junk.id, ...(job.spam.cursor ? { after: afterFilter(job.spam.cursor) } : {}) }, limit: 0, calculateTotal: true },
          "q",
        ],
      ]);
      const total = res.get("q")?.total;
      if (typeof total === "number") remaining = Math.max(0, total - job.spam.edge.length);
    } catch {
      // Progress is a nicety.
    }
    backlog = { reviewedThrough: job.spam.cursor ? new Date(job.spam.cursor) : null, remaining };
  }

  const stats: RunStats = {
    ...job.stats,
    since: new Date(job.lastDigestAt),
    model: config.aiModel,
    backlog,
    indexing: job.sent.historyComplete ? undefined : { indexed: job.sent.historyIndexed, total: job.sent.historyTotal ?? null },
    leftSpam,
    readInSpam,
    ...(config.incomingMailboxes.length && job.incoming
      ? { incoming: { checked: job.incoming.week.checked, flagged: job.incoming.week.flagged, quarantined: job.incoming.week.quarantined ?? 0 } }
      : {}),
  };
  const linker = makeLinker(config.linkTemplate, { accountId: session.accountId, mailboxId: junk.id, mailboxName: junk.name });
  const message = renderDigest({
    suspects: pending,
    rescue: { moved: pending.filter((p) => p.moved).map((p) => p.candidate.id), skipped: job.rescueSkipped },
    rescueMailboxName: b.rescueBox ? mailboxPath(b.rescueBox, b.mailboxes) : undefined,
    stats,
    now,
    timezone: config.timezone,
    sendWhenEmpty: config.sendWhenEmpty,
    link: linker,
  });
  const report: DigestReport = { kind: "digest", message, sent: false, stats, listed: pending.length, subrequests: budget.used };
  if (ctx.opts.readOnly) return report;

  if (message) {
    try {
      await makeNotifier(ctx.env, config, ctx.opts, budget).send(message);
    } catch (err) {
      // Retried by a later run (at most hourly); nothing is cleared.
      job.digestFailedAt = now.toISOString();
      recordFailures(job.stats.failures, [`the last digest could not be sent: ${errorMessage(err)}`], now);
      await writeJson(ctx.kv, KEYS.job, job);
      throw err;
    }
    report.sent = true;
  }
  // Only after a successful send: start the next period.
  job.pending = [];
  job.rescueSkipped = [];
  job.rescuedThisPeriod = 0;
  job.stats = emptyStats();
  if (job.incoming) job.incoming.week = emptyIncomingStats();
  job.lastDigestAt = now.toISOString();
  planNextDigest(job, config, now.getTime());
  delete job.digestFailedAt;
  await writeJson(ctx.kv, KEYS.job, job);
  budget.charge();
  report.subrequests = budget.used;
  return report;
}

// ---------------------------------------------------------------- incoming

/** INCOMING_MAILBOXES resolved. "Parent.Child" works as well as "Parent/Child". */
export function incomingMailboxes(specs: string[], all: Mailbox[], junkId: string): Mailbox[] {
  const found = specs.map((spec) => findMailbox(all, spec, "INCOMING_MAILBOXES"));
  if (found.some((m) => m.id === junkId)) throw new Error("INCOMING_MAILBOXES must not include Spam: Spam is reviewed separately");
  return [...new Map(found.map((m) => [m.id, m])).values()];
}

function newIncoming(key: string, cursor: string, now: Date, previous?: IncomingState): IncomingState {
  return {
    key,
    cursor,
    edge: [],
    recent: [],
    lookbackFloor: cursor,
    pending: previous?.pending ?? [],
    periodStart: now.toISOString(),
    ...(previous?.lastReportAt ? { lastReportAt: previous.lastReportAt } : {}),
    stats: emptyIncomingStats(),
    week: previous?.week ?? emptyIncomingStats(),
  };
}

/**
 * Check new mail in INCOMING_MAILBOXES for spam the filter let through:
 * facts first (src/incoming.ts), then the model, told the messages came from
 * the inbox. Read-only. Starts with mail arriving after it is switched on, and
 * keeps its own position. Returns whether the job changed.
 */
async function checkIncoming(
  ctx: Context,
  job: JobState,
  b: Boxes,
  now: Date,
  report: WorkReport,
  loadIndex: () => Promise<CorrespondentIndex>,
): Promise<boolean> {
  const { config, client, budget, env } = ctx;
  const folders = incomingMailboxes(config.incomingMailboxes, b.mailboxes, b.junk.id);
  const key = JSON.stringify([folders.map((m) => m.id).sort(), config.incomingSkipRead]);
  const settled = new Date(now.getTime() - INCOMING_SETTLE_MS).toISOString();
  if (job.incoming?.key !== key) {
    job.incoming = newIncoming(key, settled, now, job.incoming);
    return true;
  }
  const inc = job.incoming;
  // Nothing before the floor was recorded in `recent` (it is where checking
  // started, or where state saved before the look-back existed left off), so
  // the look-back never reaches behind it.
  let changed = false;
  if (!inc.lookbackFloor) {
    inc.lookbackFloor = inc.cursor;
    changed = true;
  }
  const from = new Date(Math.max(Date.parse(inc.cursor) - INCOMING_LOOKBACK_MS, Date.parse(inc.lookbackFloor) - EDGE_MS)).toISOString();
  const skip = new Set([...inc.edge, ...(inc.recent ?? [])].map((e) => e.id));
  const limit = INCOMING_SLICE + skip.size;
  const conditions: unknown[] = [
    folders.length === 1 ? { inMailbox: folders[0]!.id } : { operator: "OR", conditions: folders.map((m) => ({ inMailbox: m.id })) },
    { after: from, before: settled },
  ];
  if (config.incomingSkipRead) conditions.push({ notKeyword: "$seen" });
  const res = await client.request([
    [
      "Email/query",
      {
        accountId: b.session.accountId,
        filter: { operator: "AND", conditions },
        sort: [{ property: "receivedAt", isAscending: true }],
        limit,
      },
      "iq",
    ],
    [
      "Email/get",
      {
        accountId: b.session.accountId,
        "#ids": { resultOf: "iq", name: "Email/query", path: "/ids" },
        properties: [
          ...emailProperties({ spamHeaders: config.spamHeaders, previewChars: config.previewChars }),
          "mailboxIds",
          `header:${FASTSPAM_HEADER}:asText`,
        ],
      },
      "ig",
    ],
  ]);
  const rows = byQueryOrder(res.get("iq")?.ids, res.get("ig")?.list).filter((r) => !skip.has(String(r.id)));
  if (!rows.length) return pruneRecent(inc) || changed;

  // fastspam's own reports: the Fastmail notifier marks them; the others are
  // recognised by sender and subject.
  const own = (r: Record<string, unknown>, c: Candidate) =>
    !!r[`header:${FASTSPAM_HEADER}:asText`] || (!!config.emailFrom && c.fromEmail === config.emailFrom.toLowerCase() && c.subject.startsWith("[fastspam]"));
  const all = rows.map((r) => ({ row: r, c: toCandidate(r, config) }));
  const toCheck = all.filter((x) => !own(x.row, x.c));
  const folderOf = (r: Record<string, unknown>) => folders.find((m) => (r.mailboxIds as Record<string, boolean> | undefined)?.[m.id])?.id ?? folders[0]!.id;

  const correspondents = lookup(await loadIndex());
  let threads = new Set<string>();
  if (toCheck.length) {
    try {
      threads = await threadsWithYourMail(client, toCheck.map((x) => x.c.threadId), { sentId: b.sent.id, self: correspondents.self });
    } catch (err) {
      report.failures.push(`incoming: could not check conversations: ${errorMessage(err)}`);
    }
  }

  const finds: IncomingFind[] = [];
  const toModel: { x: (typeof toCheck)[number]; item: Item }[] = [];
  for (const x of toCheck) {
    const d = decideIncoming(x.c, {
      trustedSenders: config.trustedSenders,
      spamSenders: config.spamSenders,
      honourDmarcPolicy: config.honourDmarcPolicy,
      correspondents,
      threadsWithYourMail: threads,
    });
    if (d.outcome === "flag") finds.push(incomingFind(x.c, folderOf(x.row), d.basis, d.detail));
    else if (d.outcome === "model") {
      toModel.push({
        x,
        item: {
          key: `m${toModel.length}`,
          message: promptMessage(x.c, {
            now,
            domainKnown: correspondents.domain(x.c.fromEmail),
            repliedBefore: correspondents.repliedOnly(x.c.fromEmail),
            previewChars: config.previewChars,
          }),
        },
      });
    }
  }

  const unanswered = new Set<string>();
  let calls = 0;
  if (toModel.length) {
    const result = await classify(env.AI, toModel.map((t) => t.item), {
      model: config.aiModel,
      gatewayId: config.aiGatewayId,
      batchSize: config.batchSize,
      maxCalls: config.maxModelCallsPerRun,
      contextTokens: config.modelContextTokens,
      style: config.questionStyle,
      budget,
      context: "incoming",
    });
    calls = result.calls;
    report.failures.push(...result.failures.map((f) => `incoming: ${f}`));
    for (const t of toModel) {
      const v = result.verdicts.get(t.item.key);
      if (!v) {
        unanswered.add(t.x.c.id);
        continue;
      }
      const pSpam = Math.min(1, Math.max(0, 1 - v.notSpam));
      if (pSpam >= config.incomingThreshold) {
        finds.push({ ...incomingFind(t.x.c, folderOf(t.x.row), "model", "the model thinks this is spam"), pSpam });
      }
    }
  }

  // As in Spam: only the prefix before the first unanswered message counts.
  const firstGap = all.findIndex((x) => unanswered.has(x.c.id));
  const processed = firstGap < 0 ? all : all.slice(0, firstGap);
  const done = new Set(processed.map((x) => x.c.id));
  const checked = toCheck.filter((x) => done.has(x.c.id));
  const flagged = finds.filter((f) => done.has(f.candidate.id));
  const sentToModel = toModel.filter((t) => done.has(t.x.c.id)).length;
  const settledHere = checked.length - sentToModel - flagged.filter((f) => f.basis !== "model").length;
  for (const s of [inc.stats, inc.week]) {
    s.checked += checked.length;
    s.settledByFact += settledHere;
    s.sentToModel += sentToModel;
    s.modelCalls += calls;
    s.flagged += flagged.length;
  }
  const quarantined = await quarantineFinds(ctx, inc, b, folders, flagged, now, report);
  for (const s of [inc.stats, inc.week]) s.quarantined = (s.quarantined ?? 0) + quarantined;
  report.incoming = { checked: checked.length, settledByFact: settledHere, sentToModel, modelCalls: calls, flagged: flagged.length, quarantined };

  const pendingIds = new Set(inc.pending.map((p) => p.candidate.id));
  for (const f of flagged) {
    if (pendingIds.has(f.candidate.id) || inc.pending.length >= MAX_INCOMING_PENDING) continue;
    inc.pending.push(f);
  }
  // A late arrival is older than the position: it is remembered, but never
  // moves the position back.
  const position = Date.parse(inc.cursor);
  const moved = advance(
    processed.filter((x) => Date.parse(x.c.receivedAt) >= position).map((x) => ({ id: x.c.id, receivedAt: x.c.receivedAt })),
    inc.cursor,
    inc.edge,
  );
  inc.cursor = moved.cursor ?? inc.cursor;
  inc.edge = moved.edge;
  inc.recent = [...(inc.recent ?? []), ...processed.map((x) => ({ id: x.c.id, at: x.c.receivedAt }))];
  pruneRecent(inc);
  return true;
}

/** Keep only the ids the next look-back can return. Returns whether anything changed. */
function pruneRecent(inc: IncomingState): boolean {
  const floor = Date.parse(inc.cursor) - INCOMING_LOOKBACK_MS - EDGE_MS;
  const seen = new Set<string>();
  const kept = (inc.recent ?? []).filter((e) => Date.parse(e.at) >= floor && !seen.has(e.id) && (seen.add(e.id), true));
  const changed = kept.length !== (inc.recent ?? []).length;
  if (changed) inc.recent = kept;
  return changed;
}

/**
 * With QUARANTINE_MAILBOX set, move the clearest finds out of the checked
 * folders: facts always, model verdicts at QUARANTINE_THRESHOLD or above, at
 * most MAX_QUARANTINE_PER_DAY. Marks each find moved or not. Returns how many
 * were moved. A failure is recorded; the finds are still reported.
 */
async function quarantineFinds(
  ctx: Context,
  inc: IncomingState,
  b: Boxes,
  folders: Mailbox[],
  finds: IncomingFind[],
  now: Date,
  report: WorkReport,
): Promise<number> {
  const { config, env, budget } = ctx;
  if (!config.quarantineMailbox || ctx.opts.readOnly || config.dryRun) return 0;
  const eligible = finds.filter((f) => f.basis !== "model" || (f.pSpam ?? 0) >= config.quarantineThreshold);
  if (!eligible.length) return 0;
  try {
    const box = findMailbox(b.mailboxes, config.quarantineMailbox, "QUARANTINE_MAILBOX");
    const today = now.toISOString().slice(0, 10);
    if (inc.quarantine?.day !== today) inc.quarantine = { day: today, count: 0 };
    const writer = writeClient(env, config, ctx.opts, budget);
    if ((await writer.session()).accountId !== b.session.accountId) {
      throw new Error("FASTMAIL_WRITE_TOKEN belongs to a different account than FASTMAIL_TOKEN");
    }
    const result = await quarantine(writer, eligible.map((f) => f.candidate.id), {
      fromIds: folders.map((m) => m.id),
      quarantineId: box.id,
      max: Math.max(0, config.maxQuarantinePerDay - inc.quarantine.count),
    });
    const moved = new Set(result.moved);
    const skipped = new Map(result.skipped.map((s) => [s.id, s.reason]));
    for (const f of eligible) {
      if (moved.has(f.candidate.id)) f.movedTo = box.id;
      else if (skipped.has(f.candidate.id)) f.notMoved = skipped.get(f.candidate.id);
    }
    inc.quarantine.count += moved.size;
    return moved.size;
  } catch (err) {
    report.failures.push(`quarantine failed: ${errorMessage(err)}`);
    for (const f of eligible) f.notMoved = "quarantine failed";
    return 0;
  }
}

function incomingFind(c: Candidate, mailboxId: string, basis: IncomingFind["basis"], detail: string): IncomingFind {
  return {
    candidate: { id: c.id, threadId: c.threadId, fromName: c.fromName, fromEmail: c.fromEmail, subject: c.subject, receivedAt: c.receivedAt },
    mailboxId,
    basis,
    detail,
  };
}

/** The incoming report: whatever was found since the last one, still where it was found. */
async function sendIncomingReport(ctx: Context, job: JobState, now: Date): Promise<IncomingReport> {
  const { config, client, budget } = ctx;
  const inc = job.incoming!;
  const b = await boxes(ctx);
  let folders: Mailbox[];
  try {
    folders = incomingMailboxes(config.incomingMailboxes, b.mailboxes, b.junk.id);
  } catch {
    folders = b.mailboxes.filter((m) => inc.pending.some((p) => p.mailboxId === m.id));
  }
  const folderIds = new Set(folders.map((m) => m.id));

  // Leave out what you've dealt with: moved out of the checked folders (to
  // Spam, say), deleted, or (with INCOMING_SKIP_READ) read.
  const current = (await client.getMany(
    "Email/get",
    inc.pending.map((p) => p.candidate.id),
    ["id", "mailboxIds", "keywords"],
  )) as { id: string; mailboxIds?: Record<string, boolean>; keywords?: Record<string, boolean> }[];
  const live = new Map(current.map((e) => [e.id, e]));
  const finds = inc.pending.filter((p) => {
    const e = live.get(p.candidate.id);
    const boxes = Object.keys(e?.mailboxIds ?? {});
    // Quarantined finds are listed while they're still in quarantine.
    if (!e || !(p.movedTo ? boxes.includes(p.movedTo) : boxes.some((id) => folderIds.has(id)))) return false;
    return !(config.incomingSkipRead && e.keywords?.$seen);
  });
  const dealtWith = inc.pending.length - finds.length;
  const report: IncomingReport = { kind: "incoming-report", message: null, sent: false, listed: finds.length, dealtWith, subrequests: budget.used };

  if (finds.length) {
    const path = (id: string) => {
      const m = b.mailboxes.find((x) => x.id === id);
      return m ? mailboxPath(m, b.mailboxes) : "(folder)";
    };
    report.message = renderIncomingReport({
      finds,
      stats: inc.stats,
      since: new Date(inc.periodStart),
      now,
      timezone: config.timezone,
      folderName: path,
      dealtWith,
      link: (f) => {
        const where = f.movedTo ?? f.mailboxId;
        const m = b.mailboxes.find((x) => x.id === where);
        return makeLinker(config.linkTemplate, { accountId: b.session.accountId, mailboxId: where, mailboxName: m?.name ?? "" })(f.candidate);
      },
    });
  }
  if (ctx.opts.readOnly) return report;

  if (report.message) {
    try {
      await makeNotifier(ctx.env, config, ctx.opts, budget).send(report.message);
    } catch (err) {
      inc.reportFailedAt = now.toISOString();
      recordFailures(job.stats.failures, [`an incoming report could not be sent: ${errorMessage(err)}`], now);
      await writeJson(ctx.kv, KEYS.job, job);
      throw err;
    }
    report.sent = true;
    inc.stats = emptyIncomingStats();
    inc.periodStart = now.toISOString();
    inc.lastReportAt = now.toISOString();
  }
  // Nothing left to report (you dealt with it all) also clears the list.
  inc.pending = [];
  delete inc.reportFailedAt;
  await writeJson(ctx.kv, KEYS.job, job);
  budget.charge();
  report.subrequests = budget.used;
  return report;
}

// ---------------------------------------------------------------- alerts

/** Count a work run towards (or end) a run of failures. Returns whether the job changed. */
function countFailedRun(job: JobState, failed: boolean, now: Date): boolean {
  if (!failed) {
    if (!job.failStreak) return false;
    delete job.failStreak;
    return true;
  }
  job.failStreak = job.failStreak ? { ...job.failStreak, runs: job.failStreak.runs + 1 } : { runs: 1, since: now.toISOString() };
  return true;
}

/** Tell you about failures that keep happening, rather than waiting for the weekly digest. */
async function sendAlert(ctx: Context, job: JobState, now: Date): Promise<AlertReport> {
  const streak = job.failStreak!;
  const since = Date.parse(streak.since);
  const recent = job.stats.failures.filter((f) => f.last && Date.parse(f.last) >= since);
  const message = renderAlert({
    failures: recent.length ? recent : job.stats.failures,
    runs: streak.runs,
    since: new Date(since),
    timezone: ctx.config.timezone,
  });
  const report: AlertReport = { kind: "alert", message, sent: false, runs: streak.runs, subrequests: ctx.budget.used };
  if (ctx.opts.readOnly) return report;
  // Marked as alerted even if sending fails, so a broken notifier can't take
  // over every run; the next try is a day later.
  streak.alertedAt = now.toISOString();
  try {
    await makeNotifier(ctx.env, ctx.config, ctx.opts, ctx.budget).send(message);
    report.sent = true;
  } catch (err) {
    recordFailures(job.stats.failures, [`an alert could not be sent: ${errorMessage(err)}`], now);
    await writeJson(ctx.kv, KEYS.job, job);
    throw err;
  }
  await writeJson(ctx.kv, KEYS.job, job);
  ctx.budget.charge();
  report.subrequests = ctx.budget.used;
  return report;
}

// ---------------------------------------------------------------- notifiers

function writeClient(env: Env, config: Config, opts: RunOptions, budget: Budget): JmapClient {
  const token = env.FASTMAIL_WRITE_TOKEN;
  if (typeof token !== "string" || !token || token === "unused") {
    throw new Error("FASTMAIL_WRITE_TOKEN (Email scope) is required for NOTIFIER=fastmail, RESCUE_MAILBOX and QUARANTINE_MAILBOX");
  }
  return new JmapClient({ sessionUrl: config.jmapSessionUrl, token, fetchImpl: opts.fetchImpl, budget });
}

export function makeNotifier(env: Env, config: Config, opts: RunOptions, budget: Budget): Notifier {
  if (opts.notifier) return opts.notifier;
  if (config.dryRun) return new ConsoleNotifier();
  if (config.notifier === "fastmail") {
    return new FastmailNotifier(writeClient(env, config, opts, budget), config.emailFrom, config.emailTo, config.digestMailbox);
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

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
