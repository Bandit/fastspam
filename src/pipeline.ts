import { loadConfig, type Config } from "./config.ts";
import type { Candidate, Env, RescueResult, Suspect } from "./types.ts";
import { DETERMINISTIC_BASES } from "./types.ts";
import { Budget } from "./lib/budget.ts";
import { JmapClient, type FetchImpl, type Session } from "./jmap/client.ts";
import { listMailboxes, mailboxPath, resolveMailbox, type Mailbox } from "./jmap/mailboxes.ts";
import { emailProperties, toCandidate } from "./jmap/spam.ts";
import { threadsWithRealMail } from "./jmap/threads.ts";
import { applySent, emptyIndex, lookup, SENT_PROPERTIES, type SentRow } from "./jmap/correspondents.ts";
import { rescue } from "./jmap/rescue.ts";
import { decide } from "./decide.ts";
import { classify, type ClassifyResult } from "./ai/classify.ts";
import { isReported, type Item } from "./ai/classifier.ts";
import { promptMessage } from "./ai/prompt.ts";
import {
  addLines,
  emptyStats,
  KEYS,
  newJob,
  readJson,
  writeJson,
  type CorrespondentIndex,
  type Edge,
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
/** The position is a receivedAt; re-read a second either side of it in case the server's `after` is strict. */
const EDGE_MS = 1000;
/** Subrequests a slice needs beyond the model: one query, two for threads, two KV writes, a rescue. */
const SLICE_RESERVE = 12;
const DIGEST_RETRY_MS = 60 * MINUTE;
const MAX_PENDING = 500;

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
}

export interface DigestReport {
  kind: "digest";
  message: Message | null;
  sent: boolean;
  stats: RunStats;
  listed: number;
  subrequests: number;
}

export type RunReport = WorkReport | DigestReport;

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
  return job?.v === 1 ? job : newJob(now);
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

/** The scheduled entry point: the digest if one is due, otherwise a slice of work. */
export async function run(env: Env, now: Date, opts: RunOptions = {}): Promise<RunReport> {
  const ctx = context(env, opts);
  const job = await loadJob(ctx, now);
  const { due, planned } = digestTiming(job, ctx.config, now);
  return due ? sendDigest(ctx, job, now) : doWork(ctx, job, now, planned);
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
      addLines(saved.stats.failures, [errorMessage(err)]);
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

  const failuresBefore = job.stats.failures.length;
  addLines(job.stats.failures, report.failures);
  jobChanged ||= job.stats.failures.length !== failuresBefore || job.stats.notes.length !== linesBefore;
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
      neverReport: config.neverReport,
      alwaysReport: config.alwaysReport,
      spamScoreSkipAbove: config.spamScoreSkipAbove,
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

// ---------------------------------------------------------------- digest

async function sendDigest(ctx: Context, job: JobState, now: Date): Promise<DigestReport> {
  const { config, client, budget } = ctx;
  const b = await boxes(ctx);
  const { session, junk } = b;

  // Drop finds that have already left Spam (you rescued them, or they were purged).
  let pending = job.pending;
  const check = pending.filter((p) => !p.moved).map((p) => p.candidate.id);
  let leftSpam = 0;
  if (check.length) {
    const current = (await client.getMany("Email/get", check, ["id", "mailboxIds"])) as { id: string; mailboxIds?: Record<string, boolean> }[];
    const stillIn = new Set(current.filter((e) => e.mailboxIds?.[junk.id]).map((e) => e.id));
    pending = pending.filter((p) => p.moved || stillIn.has(p.candidate.id));
    leftSpam = job.pending.length - pending.length;
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
      addLines(job.stats.failures, [`the last digest could not be sent: ${errorMessage(err)}`]);
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
  job.lastDigestAt = now.toISOString();
  planNextDigest(job, config, now.getTime());
  delete job.digestFailedAt;
  await writeJson(ctx.kv, KEYS.job, job);
  budget.charge();
  report.subrequests = budget.used;
  return report;
}

// ---------------------------------------------------------------- notifiers

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

export function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}
