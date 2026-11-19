import type { JmapClient } from "./client.ts";
import type { CorrespondentIndex } from "../lib/state.ts";
import { cleanAddress, domainOf } from "../lib/sanitise.ts";

/**
 * The "have you written to them?" index, built from your Sent mail and kept in
 * KV. Looking an address up costs nothing and matches exactly, unlike
 * Email/query's `from` filter whose matching RFC 8621 leaves undefined.
 *
 * It distinguishes STARTING a conversation from REPLYING. Only the first is
 * treated as a fact: people reply to spammers (to unsubscribe, complain, or
 * on purpose), but a message you wrote unprompted is strong evidence the
 * address is someone you deal with.
 */

const OVERLAP_MS = 86_400_000;
/** Reply prefixes in common languages (Re, Aw, Sv, Antw, Vs, Odp, Ynt, 回复, 答复). */
const REPLY_SUBJECT = /^\s*(re|aw|sv|antw|vs|odp|ynt|回复|答复)\s*(\[\d+\])?\s*[:：]/i;

export interface UpdateOptions {
  sentId: string;
  bootstrap: number;
  max: number;
}

interface SentRow {
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

function emptyIndex(): CorrespondentIndex {
  return { v: 2, updatedAt: new Date(0).toISOString(), addresses: {}, started: {}, self: [] };
}

function keepNewest(map: Record<string, number>, max: number): Record<string, number> {
  const entries = Object.entries(map);
  if (entries.length <= max) return map;
  entries.sort((a, b) => b[1] - a[1]);
  return Object.fromEntries(entries.slice(0, max));
}

export async function updateIndex(
  client: JmapClient,
  previous: CorrespondentIndex | undefined,
  opts: UpdateOptions,
): Promise<{ index: CorrespondentIndex; scanned: number }> {
  // An index in an older format is rebuilt rather than trusted.
  const usable = previous?.v === 2 ? previous : undefined;
  const index: CorrespondentIndex = usable
    ? { v: 2, updatedAt: usable.updatedAt, addresses: { ...usable.addresses }, started: { ...usable.started }, self: [...usable.self] }
    : emptyIndex();
  const fresh = !usable || Object.keys(usable.addresses).length === 0;
  if (opts.bootstrap <= 0) return { index, scanned: 0 };

  const filter: Record<string, unknown> = { inMailbox: opts.sentId };
  if (!fresh) filter.after = new Date(Date.parse(index.updatedAt) - OVERLAP_MS).toISOString();
  const { ids } = await client.queryEmailIds(filter, opts.bootstrap);
  const rows = (await client.getMany("Email/get", ids, ["id", "from", "to", "cc", "bcc", "receivedAt", "subject", "inReplyTo", "references"])) as SentRow[];

  const self = new Set(index.self);
  let newest = Date.parse(index.updatedAt) || 0;
  for (const r of rows) {
    const at = Date.parse(r.receivedAt ?? "") || 0;
    newest = Math.max(newest, at);
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
  index.updatedAt = new Date(newest).toISOString();
  index.addresses = keepNewest(index.addresses, opts.max);
  index.started = keepNewest(index.started, opts.max);
  return { index, scanned: rows.length };
}

export interface CorrespondentLookup {
  /** epoch ms you last STARTED a conversation with this exact address, if ever */
  started(addr: string): number | undefined;
  /** true if you have written to this exact address, but only ever in reply */
  repliedOnly(addr: string): boolean;
  /** true if you have sent to anyone at this domain */
  domain(addr: string): boolean;
  isSelf(addr: string): boolean;
  self: ReadonlySet<string>;
}

export function lookup(index: CorrespondentIndex | undefined): CorrespondentLookup {
  const usable = index?.v === 2 ? index : undefined;
  const addresses = usable?.addresses ?? {};
  const started = usable?.started ?? {};
  const domains = new Set(Object.keys(addresses).map(domainOf).filter(Boolean));
  const self = new Set(usable?.self ?? []);
  return {
    started: (a) => (self.has(a) ? undefined : started[a]),
    repliedOnly: (a) => !self.has(a) && a in addresses && !(a in started),
    domain: (a) => !self.has(a) && domains.has(domainOf(a)),
    isSelf: (a) => self.has(a),
    self,
  };
}
