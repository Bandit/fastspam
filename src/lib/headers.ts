import type { AuthResult, AuthSummary } from "../types.ts";

/**
 * Deterministic header parsing.
 *
 * Spam-score headers are requested with `:all` and the FIRST instance is used:
 * receiving servers prepend headers, so the topmost is the one Fastmail added.
 *
 * Authentication-Results is different. Fastmail writes several instances (one
 * each for PTR, BIMI, ARC, and DKIM+DMARC), and a sender can add their own
 * claiming "dmarc=pass". Per RFC 8601 §5, only instances whose authserv-id is
 * the receiving server's are trusted (TRUSTED_AUTHSERV_IDS, default
 * messagingengine.com: Fastmail's MX hosts); those are merged, the rest ignored.
 */

/** A valid RFC 8621 header-field name for `header:{name}` properties. */
export function isValidHeaderName(name: string): boolean {
  return /^[\x21-\x39\x3b-\x7e]+$/.test(name);
}

/** "5.2", "score=5.2", "Yes, score=7.1 required=5.0" → number; otherwise null. */
export function parseSpamScore(value: string | null | undefined): number | null {
  if (typeof value !== "string") return null;
  const tagged = /score\s*=\s*(-?\d+(?:\.\d+)?)/i.exec(value);
  if (tagged?.[1]) return Number(tagged[1]);
  const leading = /^\s*(-?\d+(?:\.\d+)?)\b/.exec(value);
  return leading?.[1] ? Number(leading[1]) : null;
}

const RESULTS: readonly AuthResult[] = ["pass", "fail", "softfail", "neutral", "none", "temperror", "permerror", "policy", "invalid"];

export const DEFAULT_TRUSTED_AUTHSERV_IDS = ["messagingengine.com"];

/** The authserv-id of one Authentication-Results value: the text before the first ";" (minus any version). */
export function authservId(value: string): string {
  return (value.split(";")[0] ?? "").trim().split(/\s+/)[0]!.toLowerCase();
}

function trusted(id: string, trustedIds: readonly string[]): boolean {
  return trustedIds.some((t) => {
    const tt = t.trim().toLowerCase();
    return !!tt && (id === tt || id.endsWith("." + tt));
  });
}

/**
 * Merge spf/dkim/dmarc results from every TRUSTED Authentication-Results
 * instance (the first result found for each method wins).
 */
export function parseAuthResults(values: readonly string[] | string | null | undefined, trustedIds: readonly string[] = DEFAULT_TRUSTED_AUTHSERV_IDS): AuthSummary {
  const out: AuthSummary = {};
  const list = typeof values === "string" ? [values] : (values ?? []);
  for (const value of list) {
    if (typeof value !== "string" || !trusted(authservId(value), trustedIds)) continue;
    for (const method of ["spf", "dkim", "dmarc"] as const) {
      if (out[method]) continue;
      const m = new RegExp(`(?:^|[;\\s])${method}\\s*=\\s*([a-z]+)`, "i").exec(value);
      const result = m?.[1]?.toLowerCase() as AuthResult | undefined;
      if (result && RESULTS.includes(result)) out[method] = result;
    }
    if (!out.dmarcPolicy) {
      const p = /policy\.published-domain-policy\s*=\s*(none|quarantine|reject)/i.exec(value)?.[1]?.toLowerCase();
      if (p) out.dmarcPolicy = p as AuthSummary["dmarcPolicy"];
    }
  }
  return out;
}

/** First non-empty string of a `:all` header value (array), or of a plain value. */
export function firstHeader(value: unknown): string | null {
  if (Array.isArray(value)) {
    for (const v of value) if (typeof v === "string" && v.trim()) return v;
    return null;
  }
  return typeof value === "string" && value.trim() ? value : null;
}
