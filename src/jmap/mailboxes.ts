import type { JmapClient } from "./client.ts";

export interface Mailbox {
  id: string;
  name: string;
  role: string | null;
  parentId: string | null;
}

export async function listMailboxes(client: JmapClient): Promise<Mailbox[]> {
  const { accountId } = await client.session();
  const res = await client.request([["Mailbox/get", { accountId, ids: null, properties: ["id", "name", "role", "parentId"] }, "m"]]);
  return ((res.get("m")?.list as Mailbox[] | undefined) ?? []).map((m) => ({
    id: m.id,
    name: m.name,
    role: m.role ?? null,
    parentId: m.parentId ?? null,
  }));
}

/** "Parent/Child" path of a mailbox. */
export function mailboxPath(m: Mailbox, all: Mailbox[]): string {
  const parts = [m.name];
  let parent = m.parentId;
  for (let depth = 0; parent && depth < 20; depth++) {
    const p = all.find((x) => x.id === parent);
    if (!p) break;
    parts.unshift(p.name);
    parent = p.parentId;
  }
  return parts.join("/");
}

/**
 * A mailbox named in a setting: id, name or path, with "." accepted between
 * levels as well as "/" (so "Parent.Child" works).
 */
export function findMailbox(all: Mailbox[], spec: string, label: string): Mailbox {
  try {
    return resolveMailbox(all, { label, override: spec, required: true })!;
  } catch (err) {
    if (!spec.includes(".")) throw err;
    return resolveMailbox(all, { label, override: spec.replace(/\./g, "/"), required: true })!;
  }
}

/**
 * Resolve a mailbox: explicit override (id, name or path) → role → name pattern.
 * RFC 8621 defers role names to the IANA registry, so the name fallback is not
 * optional politeness: servers differ.
 */
export function resolveMailbox(
  all: Mailbox[],
  spec: { label: string; override?: string; role?: string; names?: RegExp; required: boolean },
): Mailbox | undefined {
  const o = spec.override?.trim();
  if (o) {
    const lower = o.toLowerCase();
    const hit =
      all.find((m) => m.id === o) ??
      all.find((m) => mailboxPath(m, all).toLowerCase() === lower) ??
      all.find((m) => m.name.toLowerCase() === lower);
    if (hit) return hit;
    throw new Error(`${spec.label} mailbox "${o}" not found. Mailboxes: ${all.map((m) => mailboxPath(m, all)).join(", ")}`);
  }
  const byRole = spec.role ? all.find((m) => m.role === spec.role) : undefined;
  if (byRole) return byRole;
  const byName = spec.names ? all.find((m) => spec.names!.test(m.name)) : undefined;
  if (byName) return byName;
  if (spec.required) {
    throw new Error(`could not find the ${spec.label} mailbox; set it explicitly. Mailboxes: ${all.map((m) => mailboxPath(m, all)).join(", ")}`);
  }
  return undefined;
}
