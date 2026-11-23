/**
 * KV state: two JSON documents.
 *
 *   job    progress, pending finds and stats since the last digest. Read on
 *          every run, written once per run that changes anything.
 *   index  the correspondent index built from Sent (CorrespondentIndex). Read
 *          only when a run needs it.
 *
 * KV can't update two keys atomically, so a run writes the index first and the
 * job second. Indexing a Sent message twice is harmless, so if the second
 * write is lost the next run just redoes the same page.
 */
import type { Budget } from "./budget.ts";
import type { Candidate, Suspect, Verdict } from "../types.ts";

export const KEYS = {
  job: "job",
  index: "index",
} as const;

export interface CorrespondentIndex {
  v: 3;
  /** every address you have sent to → epoch ms you last did */
  addresses: Record<string, number>;
  /**
   * addresses you STARTED a conversation with (a Sent message that was not a
   * reply) → epoch ms you last did. Replying proves little: people reply to
   * spammers. Nobody cold-emails one.
   */
  started: Record<string, number>;
  /** addresses you send FROM. Spam often forges these, so they never count as correspondents. */
  self: string[];
}

/** A find waiting for the next digest. Only what the digest shows is kept. */
export interface PendingSuspect {
  candidate: Pick<Candidate, "id" | "threadId" | "fromName" | "fromEmail" | "subject" | "receivedAt">;
  basis: Suspect["basis"];
  tier: Suspect["tier"];
  detail: string;
  verdict?: Pick<Verdict, "notSpam" | "tier" | "category" | "top">;
  /** Moved out of Spam by the rescue step. */
  moved?: boolean;
}

/** A problem, counted each time it recurs. */
export interface Failure {
  message: string;
  count: number;
  /** When it last happened (ISO). Absent for failures stored before this was recorded. */
  last?: string;
}

export interface PeriodStats {
  reviewed: number;
  droppedByRule: number;
  settledByFact: number;
  sentToModel: number;
  modelCalls: number;
  /** Deduplicated by message and counted; capped. */
  failures: Failure[];
  notes: string[];
}

/** A message just behind a position, kept so the next (overlapping) query skips it. */
export interface Edge {
  id: string;
  at: string;
}

/** Incoming mail that may be spam, waiting for the next incoming report. */
export interface IncomingFind {
  candidate: Pick<Candidate, "id" | "threadId" | "fromName" | "fromEmail" | "subject" | "receivedAt">;
  /** The checked folder it was found in. */
  mailboxId: string;
  basis: "dmarc-policy" | "blocklist" | "model";
  detail: string;
  /** P(spam) from the model. */
  pSpam?: number;
  /** Moved to this mailbox (QUARANTINE_MAILBOX). */
  movedTo?: string;
  /** Why it was eligible for quarantine but not moved. */
  notMoved?: string;
}

export interface IncomingStats {
  checked: number;
  settledByFact: number;
  sentToModel: number;
  modelCalls: number;
  flagged: number;
  /** Absent in state saved before quarantine existed. */
  quarantined?: number;
}

/** The incoming check (experimental): its own position, finds and stats. */
export interface IncomingState {
  /** The folders and settings the position belongs to; a change starts afresh. */
  key: string;
  /** receivedAt of the newest message checked (ISO). */
  cursor: string;
  edge: Edge[];
  pending: IncomingFind[];
  /** Start of the period the next incoming report covers. */
  periodStart: string;
  /** When the last incoming report went out (unset: never, so the first find is reported at once). */
  lastReportAt?: string;
  reportFailedAt?: string;
  /** Since the last incoming report. */
  stats: IncomingStats;
  /** Since the last weekly digest. */
  week: IncomingStats;
  /** Messages quarantined on `day` (UTC date), for MAX_QUARANTINE_PER_DAY. */
  quarantine?: { day: string; count: number };
}

export function emptyIncomingStats(): IncomingStats {
  return { checked: 0, settledByFact: 0, sentToModel: 0, modelCalls: 0, flagged: 0, quarantined: 0 };
}

export interface JobState {
  v: 1;
  createdAt: string;
  /** When the last digest went out (initially: when the job started). */
  lastDigestAt: string;
  /**
   * The first digest time after lastDigestAt, worked out once rather than on
   * every run (working it out can need Intl, which is costly on first use).
   */
  nextDigestAt?: string;
  /** The schedule settings nextDigestAt was worked out for. */
  scheduleKey?: string;
  /** A failed send is retried at most hourly, so a flaky notifier can't flood you. */
  digestFailedAt?: string;
  sent: {
    /** Fixed when indexing starts: history is everything before it. */
    historyBefore?: string;
    /** History messages indexed so far (the next page's position). */
    historyIndexed: number;
    historyTotal?: number;
    historyComplete: boolean;
    /** New Sent mail is indexed from here on. */
    newFrom?: string;
    newEdge: Edge[];
  };
  spam: {
    /** receivedAt of the newest Spam message reviewed (ISO). Unset until the first slice. */
    cursor?: string;
    /** Reviewed messages within a second of the cursor, which the next query re-reads. */
    edge: Edge[];
    /** Set once a slice came back short: the first pass through Spam is done. */
    caughtUpAt?: string;
  };
  pending: PendingSuspect[];
  rescueSkipped: { id: string; reason: string }[];
  rescuedThisPeriod: number;
  stats: PeriodStats;
  /** Present once INCOMING_MAILBOXES is set. */
  incoming?: IncomingState;
  /** Work runs in a row that hit a problem, and when the first of them ran. */
  failStreak?: { runs: number; since: string; alertedAt?: string };
}

export function emptyStats(): PeriodStats {
  return { reviewed: 0, droppedByRule: 0, settledByFact: 0, sentToModel: 0, modelCalls: 0, failures: [], notes: [] };
}

export function newJob(now: Date): JobState {
  return {
    v: 1,
    createdAt: now.toISOString(),
    lastDigestAt: now.toISOString(),
    sent: { historyIndexed: 0, historyComplete: false, newEdge: [] },
    spam: { edge: [] },
    pending: [],
    rescueSkipped: [],
    rescuedThisPeriod: 0,
    stats: emptyStats(),
  };
}

const MAX_MESSAGES = 20;

/** Add failure or note lines, deduplicated and capped so state can't grow without bound. */
export function addLines(target: string[], lines: readonly string[]): void {
  for (const l of lines) if (!target.includes(l) && target.length < MAX_MESSAGES) target.push(l);
}

/** Record problems: a repeat bumps its count and time, a new one is added while there's room. */
export function recordFailures(target: Failure[], messages: readonly string[], now: Date): void {
  for (const message of messages) {
    const hit = target.find((f) => f.message === message);
    if (hit) {
      hit.count++;
      hit.last = now.toISOString();
    } else if (target.length < MAX_MESSAGES) {
      target.push({ message, count: 1, last: now.toISOString() });
    }
  }
}

/** Failures as stored before they were counted were plain strings. */
export function upgradeFailures(list: readonly unknown[]): Failure[] {
  return list.map((f) => (typeof f === "string" ? { message: f, count: 1 } : (f as Failure)));
}

export async function readJson<T>(kv: KVNamespace, key: string, budget?: Budget): Promise<T | undefined> {
  budget?.take();
  const v = await kv.get(key, "json");
  return (v ?? undefined) as T | undefined;
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown, budget?: Budget): Promise<void> {
  budget?.take();
  await kv.put(key, JSON.stringify(value));
}
