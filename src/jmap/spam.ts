import type { Candidate } from "../types.ts";
import type { JmapClient } from "./client.ts";
import { firstHeader, isValidHeaderName, parseAuthResults, parseSpamScore } from "../lib/headers.ts";

export interface FetchOptions {
  junkId: string;
  /** authserv-ids whose Authentication-Results are trusted (see lib/headers.ts). */
  trustedAuthservIds?: readonly string[];
  after: Date;
  max: number;
  spamHeaders: string[];
  /** 0 = do not fetch `preview` at all. */
  previewChars: number;
}

export interface FetchResult {
  candidates: Candidate[];
  /** Messages in Spam within the window (may exceed candidates.length when capped). */
  total: number;
}

const AUTH = "header:Authentication-Results:asText:all";

export function emailProperties(opts: Pick<FetchOptions, "spamHeaders" | "previewChars">): string[] {
  const props = ["id", "threadId", "subject", "from", "receivedAt", AUTH];
  if (opts.previewChars > 0) props.push("preview");
  for (const h of opts.spamHeaders) if (isValidHeaderName(h)) props.push(`header:${h}:asText:all`);
  return props;
}

export async function fetchCandidates(client: JmapClient, opts: FetchOptions): Promise<FetchResult> {
  const { accountId, maxObjectsInGet } = await client.session();
  const filter = { inMailbox: opts.junkId, after: opts.after.toISOString() };
  const properties = emailProperties(opts);
  let rows: Record<string, unknown>[];
  let total: number;

  if (opts.max <= maxObjectsInGet) {
    // Common case: one round trip, Email/get back-referencing Email/query (RFC 8620 §3.7).
    const res = await client.request([
      ["Email/query", { accountId, filter, sort: [{ property: "receivedAt", isAscending: false }], limit: opts.max, calculateTotal: true }, "q"],
      ["Email/get", { accountId, "#ids": { resultOf: "q", name: "Email/query", path: "/ids" }, properties }, "g"],
    ]);
    const q = res.get("q") ?? {};
    rows = (res.get("g")?.list as Record<string, unknown>[] | undefined) ?? [];
    total = typeof q.total === "number" ? q.total : rows.length;
  } else {
    const q = await client.queryEmailIds(filter, opts.max);
    rows = await client.getMany("Email/get", q.ids, properties);
    total = q.total ?? q.ids.length;
  }
  return { candidates: rows.map((r) => toCandidate(r, opts)), total };
}

export function toCandidate(r: Record<string, unknown>, opts: Pick<FetchOptions, "spamHeaders" | "previewChars" | "trustedAuthservIds">): Candidate {
  const from = Array.isArray(r.from) ? (r.from[0] as { name?: string | null; email?: string } | undefined) : undefined;
  const spamHeaders: Record<string, string> = {};
  let spamScore: number | null = null;
  for (const h of opts.spamHeaders) {
    const v = firstHeader(r[`header:${h}:asText:all`]);
    if (v === null) continue;
    spamHeaders[h] = v;
    spamScore ??= parseSpamScore(v);
  }
  return {
    id: String(r.id),
    threadId: String(r.threadId ?? ""),
    fromName: typeof from?.name === "string" ? from.name : "",
    fromEmail: typeof from?.email === "string" ? from.email.trim().toLowerCase() : "",
    subject: typeof r.subject === "string" ? r.subject : "",
    receivedAt: typeof r.receivedAt === "string" ? r.receivedAt : "",
    preview: opts.previewChars > 0 && typeof r.preview === "string" ? r.preview.slice(0, opts.previewChars) : "",
    spamScore,
    spamHeaders,
    auth: parseAuthResults(Array.isArray(r[AUTH]) ? (r[AUTH] as string[]) : [], opts.trustedAuthservIds),
  };
}
