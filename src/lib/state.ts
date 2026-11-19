/**
 * KV state. One JSON document per key, written only after the digest is sent.
 *
 *   lastrun         ISO timestamp of the last run whose digest was delivered
 *   reviewed        { [emailId]: epochMs first reviewed } — never re-reported
 *   correspondents  CorrespondentIndex built from your Sent folder
 */
import type { Budget } from "./budget.ts";

export const KEYS = {
  lastRun: "lastrun",
  reviewed: "reviewed",
  correspondents: "correspondents",
} as const;

export type Reviewed = Record<string, number>;

export interface CorrespondentIndex {
  v: 2;
  /** receivedAt of the newest Sent message indexed (ISO). */
  updatedAt: string;
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

export async function readJson<T>(kv: KVNamespace, key: string, budget?: Budget): Promise<T | undefined> {
  budget?.take();
  const v = await kv.get(key, "json");
  return (v ?? undefined) as T | undefined;
}

export async function writeJson(kv: KVNamespace, key: string, value: unknown, budget?: Budget): Promise<void> {
  budget?.take();
  await kv.put(key, JSON.stringify(value));
}

/** Drop reviewed ids older than `forgetAfterDays`. */
export function pruneReviewed(reviewed: Reviewed, now: number, forgetAfterDays: number): Reviewed {
  const cutoff = now - forgetAfterDays * 86_400_000;
  const out: Reviewed = {};
  for (const [id, at] of Object.entries(reviewed)) if (at >= cutoff) out[id] = at;
  return out;
}
