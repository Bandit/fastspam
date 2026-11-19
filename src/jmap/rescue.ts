import type { RescueResult } from "../types.ts";
import type { JmapClient } from "./client.ts";

/**
 * The only operation fastspam performs on mail, and only when RESCUE_MAILBOX is
 * set. Deliberately narrow:
 *
 *  - the destination is one mailbox id resolved from config at startup, never
 *    anything a model produced;
 *  - each message is re-read first and skipped unless it is still in Junk;
 *  - the patch removes the Junk membership and adds the rescue one, and
 *    touches nothing else (no keywords, no other mailboxes);
 *  - there is no `destroy` anywhere in this codebase;
 *  - at most `max` messages per run.
 */
export async function rescue(
  client: JmapClient,
  ids: string[],
  opts: { junkId: string; rescueId: string; max: number },
): Promise<RescueResult> {
  const result: RescueResult = { moved: [], skipped: [] };
  if (!ids.length) return result;
  if (opts.rescueId === opts.junkId) throw new Error("RESCUE_MAILBOX must not be the Spam mailbox");

  const current = (await client.getMany("Email/get", ids, ["id", "mailboxIds"])) as {
    id: string;
    mailboxIds?: Record<string, boolean>;
  }[];
  const inJunk = new Set(current.filter((e) => e.mailboxIds?.[opts.junkId]).map((e) => e.id));

  const toMove: string[] = [];
  for (const id of ids) {
    if (!inJunk.has(id)) result.skipped.push({ id, reason: "no longer in Spam" });
    else if (toMove.length >= opts.max) result.skipped.push({ id, reason: `MAX_RESCUES_PER_RUN (${opts.max}) reached` });
    else toMove.push(id);
  }
  if (!toMove.length) return result;

  const { accountId } = await client.session();
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of toMove) {
    update[id] = { [`mailboxIds/${opts.junkId}`]: null, [`mailboxIds/${opts.rescueId}`]: true };
  }
  const res = await client.request([["Email/set", { accountId, update }, "s"]]);
  const s = res.get("s") ?? {};
  const notUpdated = (s.notUpdated ?? {}) as Record<string, { type?: string }>;
  for (const id of toMove) {
    if (notUpdated[id]) result.skipped.push({ id, reason: `server refused: ${notUpdated[id]?.type ?? "unknown"}` });
    else result.moved.push(id);
  }
  return result;
}
