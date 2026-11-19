import { TIERS, type Env, type QuestionStyle, type Tier } from "./types.ts";
import type { Thresholds } from "./ai/classifier.ts";
import { DEFAULT_MODEL } from "./ai/models.ts";
import { DEFAULT_TRUSTED_AUTHSERV_IDS } from "./lib/headers.ts";

export type NotifierKind = "fastmail" | "postmark" | "cloudflare";

export interface Config {
  dryRun: boolean;
  notifier: NotifierKind;
  timezone: string;
  emailFrom: string;
  emailTo: string[];
  postmarkStream: string;

  jmapSessionUrl: string;
  /** Placeholders: {id} {threadId} {mailboxId} {mailboxName} {accountId}. Empty = no links. */
  linkTemplate: string;
  spamMailbox: string;
  sentMailbox: string;
  rescueMailbox: string;

  /** When the digest goes out: weekdays (0 = Sunday) at DIGEST_HOUR, in TIMEZONE. */
  digestDays: number[];
  digestHour: number;
  /** Spam messages reviewed per slice of work. */
  spamSlice: number;
  /** Sent messages indexed per slice of work. */
  sentPage: number;
  /** Slices of work per run (1 fits the Workers Free CPU limit). */
  maxSlicesPerRun: number;
  /** How far back the first pass through Spam starts; null = all of it. */
  backlogDays: number | null;
  previewChars: number;
  spamHeaders: string[];
  spamScoreSkipAbove: number | null;
  /** Authentication-Results from these authserv-ids (and subdomains) are trusted. */
  trustedAuthservIds: string[];

  alwaysReport: string[];
  neverReport: string[];

  aiModel: string;
  aiGatewayId: string;
  batchSize: number;
  maxModelCallsPerRun: number;
  /** Override of the model's context window used by the batch token guard. */
  modelContextTokens: number | null;
  confidenceThreshold: number;
  /** CONFIDENCE_THRESHOLD, with per-tier overrides from TIER_THRESHOLDS. */
  thresholds: Thresholds;
  /** Tiers that appear in the digest. */
  reportTiers: Tier[];
  questionStyle: QuestionStyle;
  /** Drop DMARC failures when the sender's own domain publishes quarantine/reject. */
  honourDmarcPolicy: boolean;

  rescueBasis: "deterministic" | "all";
  maxRescuesPerDigest: number;

  correspondentMax: number;
  sendWhenEmpty: boolean;
  /** Subrequests this run may make (Workers Free allows 50 per invocation). */
  subrequestBudget: number;
}

export function list(v: unknown): string[] {
  if (typeof v !== "string") return [];
  return v
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function num(v: unknown, fallback: number): number {
  if (typeof v !== "string" || v.trim() === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function optionalNum(v: unknown): number | null {
  if (typeof v !== "string" || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function bool(v: unknown, fallback = false): boolean {
  if (typeof v !== "string" || v.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(v.trim().toLowerCase());
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" && v.trim() ? v.trim() : fallback;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const WEEKDAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

/** "mon", "mon,thu", "daily" → weekday numbers (0 = Sunday). Unknown names are ignored; nothing valid → Monday. */
export function digestDays(v: unknown): number[] {
  const parts = list(typeof v === "string" ? v.toLowerCase() : "mon");
  if (parts.includes("daily")) return [0, 1, 2, 3, 4, 5, 6];
  const days = [...new Set(parts.map((p) => WEEKDAYS.indexOf(p.slice(0, 3))).filter((d) => d >= 0))].sort();
  return days.length ? days : [1];
}

/**
 * Only the score is used. Fastmail also sets X-Spam-hits (the rules that fired),
 * but nothing reads it, and fetching it was about a quarter of the Spam fetch.
 */
export const DEFAULT_SPAM_HEADERS = ["X-Spam-score"];
export const DEFAULT_LINK_TEMPLATE = "https://app.fastmail.com/mail/{mailboxName}/{threadId}.{id}";

/** "promotional:0.8, important:0.5" → per-tier overrides. Unknown tiers and bad numbers are ignored. */
export function tierThresholds(v: unknown, fallback: number): Thresholds {
  const out: Partial<Record<Tier, number>> & { default: number } = { default: fallback };
  for (const part of list(v)) {
    const [k, n] = part.split(":").map((s) => s.trim());
    const value = Number(n);
    if ((TIERS as readonly string[]).includes(k ?? "") && n !== undefined && n !== "" && Number.isFinite(value)) out[k as Tier] = clamp(value, 0, 1);
  }
  return out;
}

export function loadConfig(env: Env): Config {
  const confidenceThreshold = clamp(num(env.CONFIDENCE_THRESHOLD, 0.6), 0, 1);
  const tiers = list(env.REPORT_TIERS).filter((t): t is Tier => (TIERS as readonly string[]).includes(t));
  const notifier = str(env.NOTIFIER, "fastmail");
  return {
    dryRun: bool(env.DRY_RUN),
    notifier: notifier === "postmark" || notifier === "cloudflare" ? notifier : "fastmail",
    timezone: str(env.TIMEZONE, "UTC"),
    // "unused" is what the deploy button tells people to enter for values they don't need.
    emailFrom: str(env.EMAIL_FROM) === "unused" ? "" : str(env.EMAIL_FROM),
    emailTo: list(env.EMAIL_TO).filter((a) => a !== "unused"),
    postmarkStream: str(env.POSTMARK_MESSAGE_STREAM, "outbound"),

    jmapSessionUrl: str(env.JMAP_SESSION_URL, "https://api.fastmail.com/jmap/session"),
    linkTemplate: env.FASTMAIL_LINK_TEMPLATE === undefined ? DEFAULT_LINK_TEMPLATE : String(env.FASTMAIL_LINK_TEMPLATE).trim(),
    spamMailbox: str(env.SPAM_MAILBOX),
    sentMailbox: str(env.SENT_MAILBOX),
    rescueMailbox: str(env.RESCUE_MAILBOX),

    digestDays: digestDays(env.DIGEST_DAYS),
    digestHour: clamp(Math.floor(num(env.DIGEST_HOUR, 20)), 0, 23),
    spamSlice: clamp(Math.floor(num(env.SPAM_SLICE, 40)), 1, 1000),
    sentPage: clamp(Math.floor(num(env.SENT_PAGE, 200)), 10, 5000),
    maxSlicesPerRun: clamp(Math.floor(num(env.MAX_SLICES_PER_RUN, 1)), 1, 1000),
    backlogDays: optionalNum(env.BACKLOG_DAYS) === null ? null : clamp(optionalNum(env.BACKLOG_DAYS)!, 1, 3650),
    previewChars: clamp(Math.floor(num(env.PREVIEW_CHARS, 200)), 0, 256),
    spamHeaders: env.SPAM_HEADERS === undefined ? DEFAULT_SPAM_HEADERS : list(env.SPAM_HEADERS),
    spamScoreSkipAbove: optionalNum(env.SPAM_SCORE_SKIP_ABOVE),
    trustedAuthservIds: env.TRUSTED_AUTHSERV_IDS === undefined ? DEFAULT_TRUSTED_AUTHSERV_IDS : list(env.TRUSTED_AUTHSERV_IDS),

    alwaysReport: list(env.ALWAYS_REPORT),
    neverReport: list(env.NEVER_REPORT),

    aiModel: str(env.AI_MODEL, DEFAULT_MODEL),
    aiGatewayId: str(env.AI_GATEWAY_ID),
    batchSize: clamp(Math.floor(num(env.BATCH_SIZE, 16)), 1, 1000),
    maxModelCallsPerRun: clamp(Math.floor(num(env.MAX_MODEL_CALLS_PER_RUN, 16)), 0, 1000),
    modelContextTokens: optionalNum(env.MODEL_CONTEXT_TOKENS),
    confidenceThreshold,
    thresholds: tierThresholds(env.TIER_THRESHOLDS, confidenceThreshold),
    reportTiers: tiers.length ? tiers : [...TIERS],
    questionStyle: str(env.QUESTION_STYLE) === "yesno" ? "yesno" : "categories",
    honourDmarcPolicy: bool(env.HONOUR_DMARC_POLICY, true),

    rescueBasis: str(env.RESCUE_BASIS) === "all" ? "all" : "deterministic",
    maxRescuesPerDigest: clamp(Math.floor(num(env.MAX_RESCUES_PER_DIGEST, 20)), 0, 500),

    correspondentMax: clamp(Math.floor(num(env.CORRESPONDENT_MAX, 5000)), 100, 100_000),
    sendWhenEmpty: bool(env.SEND_WHEN_EMPTY, true),
    subrequestBudget: clamp(Math.floor(num(env.SUBREQUEST_BUDGET, 45)), 10, 10_000),
  };
}
