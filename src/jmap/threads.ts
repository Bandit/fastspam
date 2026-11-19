import type { JmapClient } from "./client.ts";
import { cleanAddress } from "../lib/sanitise.ts";

/**
 * Threads that contain a message you RECEIVED AND KEPT: one that is not in
 * Junk, Trash or Sent, and was not sent by you. Your own messages do not count,
 * because replying to a spammer puts your reply in their thread; what makes a
 * conversation real is mail from the other side that you chose to keep.
 *
 * Two batched calls: Thread/get, then Email/get of mailboxIds and from for the
 * sibling messages.
 */
export async function threadsWithRealMail(
  client: JmapClient,
  threadIds: string[],
  opts: { exclude: string[]; self: ReadonlySet<string> },
): Promise<Set<string>> {
  const unique = [...new Set(threadIds.filter(Boolean))];
  const found = new Set<string>();
  if (!unique.length) return found;

  const threads = (await client.getMany("Thread/get", unique, ["id", "emailIds"])) as { id: string; emailIds?: string[] }[];
  const threadOf = new Map<string, string>();
  for (const t of threads) {
    // A lone message is its own thread: nothing to learn.
    if ((t.emailIds?.length ?? 0) < 2) continue;
    for (const e of t.emailIds ?? []) threadOf.set(e, t.id);
  }
  if (!threadOf.size) return found;

  const excluded = new Set(opts.exclude);
  const emails = (await client.getMany("Email/get", [...threadOf.keys()], ["id", "mailboxIds", "from"])) as {
    id: string;
    mailboxIds?: Record<string, boolean>;
    from?: { email?: string }[] | null;
  }[];
  for (const e of emails) {
    const kept = Object.keys(e.mailboxIds ?? {}).some((m) => !excluded.has(m));
    const fromSelf = (e.from ?? []).some((f) => opts.self.has(cleanAddress(f.email)));
    if (kept && !fromSelf) {
      const t = threadOf.get(e.id);
      if (t) found.add(t);
    }
  }
  return found;
}

/**
 * Threads you have written in: one of their messages is in Sent or was sent
 * by you. For incoming mail this means a conversation you took part in, which
 * a spammer's fake "Re:" subject doesn't create. Two batched calls.
 */
export async function threadsWithYourMail(
  client: JmapClient,
  threadIds: string[],
  opts: { sentId: string; self: ReadonlySet<string> },
): Promise<Set<string>> {
  const unique = [...new Set(threadIds.filter(Boolean))];
  const found = new Set<string>();
  if (!unique.length) return found;
  const threads = (await client.getMany("Thread/get", unique, ["id", "emailIds"])) as { id: string; emailIds?: string[] }[];
  const threadOf = new Map<string, string>();
  for (const t of threads) {
    if ((t.emailIds?.length ?? 0) < 2) continue;
    for (const e of t.emailIds ?? []) threadOf.set(e, t.id);
  }
  if (!threadOf.size) return found;
  const emails = (await client.getMany("Email/get", [...threadOf.keys()], ["id", "mailboxIds", "from"])) as {
    id: string;
    mailboxIds?: Record<string, boolean>;
    from?: { email?: string }[] | null;
  }[];
  for (const e of emails) {
    const yours = !!e.mailboxIds?.[opts.sentId] || (e.from ?? []).some((f) => opts.self.has(cleanAddress(f.email)));
    const t = threadOf.get(e.id);
    if (yours && t) found.add(t);
  }
  return found;
}
