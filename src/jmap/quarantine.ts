import type { RescueResult } from "../types.ts";
import type { JmapClient } from "./client.ts";

/**
 * Move incoming mail flagged as spam into QUARANTINE_MAILBOX: the incoming
 * check's only write, and only when that setting is on. As narrow as rescue:
 *
 *  - the destination is one mailbox id resolved from config, never anything a
 *    model produced, and it can't be one of the checked folders;
 *  - each message is re-read first and skipped unless it is still in one of
 *    the checked folders (you may have dealt with it already);
 *  - the patch removes the checked-folder memberships and adds the quarantine
 *    one, and touches nothing else (no keywords, no other mailboxes);
 *  - nothing is ever deleted;
 *  - at most `max` messages per call (what is left of the daily allowance).
 */
export async function quarantine(
  client: JmapClient,
  ids: string[],
  opts: { fromIds: string[]; quarantineId: string; max: number },
): Promise<RescueResult> {
  const result: RescueResult = { moved: [], skipped: [] };
  if (!ids.length) return result;
  if (opts.fromIds.includes(opts.quarantineId)) throw new Error("QUARANTINE_MAILBOX must not be one of INCOMING_MAILBOXES");

  const current = (await client.getMany("Email/get", ids, ["id", "mailboxIds"])) as {
    id: string;
    mailboxIds?: Record<string, boolean>;
  }[];
  const from = new Set(opts.fromIds);
  const membership = new Map(current.map((e) => [e.id, Object.keys(e.mailboxIds ?? {}).filter((m) => from.has(m))]));

  const toMove: string[] = [];
  for (const id of ids) {
    if (!membership.get(id)?.length) result.skipped.push({ id, reason: "no longer in a checked folder" });
    else if (toMove.length >= opts.max) result.skipped.push({ id, reason: "MAX_QUARANTINE_PER_DAY reached" });
    else toMove.push(id);
  }
  if (!toMove.length) return result;

  const { accountId } = await client.session();
  const update: Record<string, Record<string, unknown>> = {};
  for (const id of toMove) {
    const patch: Record<string, unknown> = { [`mailboxIds/${opts.quarantineId}`]: true };
    for (const m of membership.get(id)!) patch[`mailboxIds/${m}`] = null;
    update[id] = patch;
  }
  const res = await client.request([["Email/set", { accountId, update }, "s"]]);
  const notUpdated = ((res.get("s") ?? {}).notUpdated ?? {}) as Record<string, { type?: string }>;
  for (const id of toMove) {
    if (notUpdated[id]) result.skipped.push({ id, reason: `server refused: ${notUpdated[id]?.type ?? "unknown"}` });
    else result.moved.push(id);
  }
  return result;
}
