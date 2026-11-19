import type { CorrespondentIndex } from "../lib/state.ts";
import { cleanAddress, domainOf } from "../lib/sanitise.ts";
import { isFreemail } from "../lib/freemail.ts";

/**
 * The "have you written to them?" index, built from your Sent mail a page at a
 * time and kept in KV. Looking an address up costs nothing and matches
 * exactly, unlike Email/query's `from` filter whose matching RFC 8621 leaves
 * undefined.
 *
 * It distinguishes STARTING a conversation from REPLYING. Only the first is
 * treated as a fact: people reply to spammers (to unsubscribe, complain, or
 * on purpose), but a message you wrote unprompted is strong evidence the
 * address is someone you deal with.
 *
 * Applying the same message twice changes nothing, which is what lets the
 * paging overlap safely.
 */

/** Reply prefixes in common languages (Re, Aw, Sv, Antw, Vs, Odp, Ynt, 回复, 答复). */
const REPLY_SUBJECT = /^\s*(re|aw|sv|antw|vs|odp|ynt|回复|答复)\s*(\[\d+\])?\s*[:：]/i;

/**
 * What is fetched for each Sent message. `references` is left out: it was over
 * a third of the response, and on a real account no Sent message was a reply
 * by References alone (each also had In-Reply-To or a reply subject).
 * isReply still honours it when present.
 */
export const SENT_PROPERTIES = ["id", "from", "to", "cc", "bcc", "receivedAt", "subject", "inReplyTo"];

export interface SentRow {
  from?: { email?: string }[] | null;
  to?: { email?: string }[] | null;
  cc?: { email?: string }[] | null;
  bcc?: { email?: string }[] | null;
  receivedAt?: string;
  subject?: string | null;
  inReplyTo?: string[] | null;
  references?: string[] | null;
}

/**
 * Conservative: anything that looks like a reply is a reply. A false "reply"
 * only sends a message to the model; a false "started" would wave spam through.
 */
export function isReply(r: Pick<SentRow, "subject" | "inReplyTo" | "references">): boolean {
  return (r.inReplyTo?.length ?? 0) > 0 || (r.references?.length ?? 0) > 0 || REPLY_SUBJECT.test(r.subject ?? "");
}

export function emptyIndex(): CorrespondentIndex {
  return { v: 3, addresses: {}, started: {}, self: [] };
}

function keepNewest(map: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, max));
}

/** Fold a page of Sent messages into the index (mutates and returns it). */
export function applySent(index: CorrespondentIndex, rows: readonly SentRow[], max: number): CorrespondentIndex {
  const self = new Set(index.self);
  for (const r of rows) {
    const at = Date.parse(r.receivedAt ?? "") || 0;
    for (const f of r.from ?? []) if (f.email) self.add(cleanAddress(f.email));
    const started = !isReply(r);
    for (const a of [...(r.to ?? []), ...(r.cc ?? []), ...(r.bcc ?? [])]) {
      const addr = cleanAddress(a.email);
      if (!addr.includes("@")) continue;
      index.addresses[addr] = Math.max(index.addresses[addr] ?? 0, at);
      if (started) index.started[addr] = Math.max(index.started[addr] ?? 0, at);
    }
  }
  // You are not your own correspondent: spam routinely forges your own address.
  for (const s of self) {
    delete index.addresses[s];
    delete index.started[s];
  }
  index.self = [...self].sort();
  index.addresses = keepNewest(index.addresses, max);
  index.started = keepNewest(index.started, max);
  return index;
}

export interface CorrespondentLookup {
  /** epoch ms you last STARTED a conversation with this exact address, if ever */
  started(addr: string): number | undefined;
  /** true if you have written to this exact address, but only ever in reply */
  repliedOnly(addr: string): boolean;
  /** true if you have sent to anyone at this domain (never for free webmail domains: see lib/freemail.ts) */
  domain(addr: string): boolean;
  isSelf(addr: string): boolean;
  self: ReadonlySet<string>;
}

export function lookup(index: CorrespondentIndex | undefined): CorrespondentLookup {
  const usable = index?.v === 3 ? index : undefined;
  const addresses = usable?.addresses ?? {};
  const started = usable?.started ?? {};
  const domains = new Set(Object.keys(addresses).map(domainOf).filter((d) => d && !isFreemail(d)));
  const self = new Set(usable?.self ?? []);
  return {
    started: (a) => (self.has(a) ? undefined : started[a]),
    repliedOnly: (a) => !self.has(a) && a in addresses && !(a in started),
    domain: (a) => !self.has(a) && domains.has(domainOf(a)),
    isSelf: (a) => self.has(a),
    self,
  };
}
