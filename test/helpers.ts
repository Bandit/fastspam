import type { AiBinding, Category, Env } from "../src/types.ts";
import { CATEGORIES } from "../src/types.ts";
import type { PromptMessage } from "../src/ai/classifier.ts";

export class MemoryKV {
  store = new Map<string, string>();
  puts = 0;
  async get(key: string, type?: string) {
    const v = this.store.get(key);
    if (v === undefined) return null;
    return type === "json" ? JSON.parse(v) : v;
  }
  async put(key: string, value: string) {
    this.puts++;
    this.store.set(key, value);
  }
  async delete(key: string) {
    this.store.delete(key);
  }
}

export function testEnv(overrides: Record<string, unknown> = {}): Env & { FASTSPAM_STATE: KVNamespace } {
  return {
    FASTSPAM_STATE: new MemoryKV() as unknown as KVNamespace,
    FASTMAIL_TOKEN: "read-token",
    DRY_RUN: "false",
    NOTIFIER: "postmark",
    EMAIL_FROM: "fastspam@sender.example",
    EMAIL_TO: "owner@owner.example",
    POSTMARK_SERVER_TOKEN: "pm-token",
    ...overrides,
  } as Env & { FASTSPAM_STATE: KVNamespace };
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

// ---------------------------------------------------------------- fake JMAP

export interface FakeEmail {
  id: string;
  threadId: string;
  mailboxIds: Record<string, boolean>;
  from?: { name?: string | null; email: string }[];
  to?: { email: string }[];
  cc?: { email: string }[];
  bcc?: { email: string }[];
  subject?: string;
  receivedAt: string;
  preview?: string;
  inReplyTo?: string[] | null;
  references?: string[] | null;
  /** lower-cased header name → instances, topmost first */
  headers?: Record<string, string[]>;
}

export const MAILBOXES = [
  { id: "mb-inbox", name: "Inbox", role: "inbox", parentId: null },
  { id: "mb-junk", name: "Spam", role: "junk", parentId: null },
  { id: "mb-sent", name: "Sent", role: "sent", parentId: null },
  { id: "mb-trash", name: "Trash", role: "trash", parentId: null },
  { id: "mb-archive", name: "Archive", role: "archive", parentId: null },
  { id: "mb-rescued", name: "Rescued", role: null, parentId: null },
];

export interface FakeJmapOptions {
  emails?: FakeEmail[];
  mailboxes?: typeof MAILBOXES;
  maxCallsInRequest?: number;
  maxObjectsInGet?: number;
  /** token → { accountId, readOnly } */
  tokens?: Record<string, { accountId: string; readOnly: boolean }>;
  /** Server-side cap on Email/query limit (to exercise paging). */
  queryLimitCap?: number;
}

/** Enough of a JMAP server to test real request shapes, limits and back-references. */
export class FakeJmap {
  emails: FakeEmail[];
  mailboxes: typeof MAILBOXES;
  opts: FakeJmapOptions;
  requests: { token: string; url: string; calls: [string, Record<string, unknown>, string][] }[] = [];
  created: Record<string, unknown>[] = [];
  private nextId = 1;

  constructor(opts: FakeJmapOptions = {}) {
    this.opts = opts;
    this.emails = opts.emails ?? [];
    this.mailboxes = opts.mailboxes ?? MAILBOXES;
  }

  private tokens() {
    return this.opts.tokens ?? {
      "read-token": { accountId: "acc1", readOnly: true },
      "write-token": { accountId: "acc1", readOnly: false },
    };
  }

  /** Every method call made, flattened. */
  get calls() {
    return this.requests.flatMap((r) => r.calls.map((c) => ({ token: r.token, name: c[0], args: c[1] })));
  }

  fetch = async (url: string, init?: RequestInit): Promise<Response> => {
    const auth = new Headers(init?.headers).get("Authorization") ?? "";
    const token = auth.replace(/^Bearer /, "");
    const account = this.tokens()[token];
    if (!account) return new Response("unauthorized", { status: 401 });
    if (url.endsWith("/session")) {
      return jsonResponse({
        apiUrl: "https://jmap.test/api/",
        primaryAccounts: { "urn:ietf:params:jmap:mail": account.accountId },
        accounts: { [account.accountId]: { isReadOnly: account.readOnly } },
        capabilities: {
          "urn:ietf:params:jmap:core": {
            maxCallsInRequest: this.opts.maxCallsInRequest ?? 16,
            maxObjectsInGet: this.opts.maxObjectsInGet ?? 500,
          },
        },
      });
    }
    const body = JSON.parse(String(init?.body)) as { methodCalls: [string, Record<string, unknown>, string][] };
    this.requests.push({ token, url, calls: body.methodCalls });
    if (body.methodCalls.length > (this.opts.maxCallsInRequest ?? 16)) {
      return jsonResponse({ type: "urn:ietf:params:jmap:error:limit", limit: "maxCallsInRequest" }, 400);
    }
    const responses: [string, Record<string, unknown>, string][] = [];
    for (const [name, rawArgs, id] of body.methodCalls) {
      const args = this.resolveRefs(rawArgs, responses);
      try {
        responses.push([name, this.method(name, args, account.readOnly), id]);
      } catch (e) {
        responses.push(["error", { type: (e as Error).message }, id]);
      }
    }
    return jsonResponse({ methodResponses: responses });
  };

  private resolveRefs(args: Record<string, unknown>, responses: [string, Record<string, unknown>, string][]) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args)) {
      if (!k.startsWith("#")) {
        out[k] = v;
        continue;
      }
      const ref = v as { resultOf: string; name: string; path: string };
      const r = responses.find((x) => x[2] === ref.resultOf && x[0] === ref.name);
      if (!r || ref.path !== "/ids") throw new Error("invalidResultReference");
      out[k.slice(1)] = r[1].ids;
    }
    return out;
  }

  private method(name: string, args: Record<string, unknown>, readOnly: boolean): Record<string, unknown> {
    const max = this.opts.maxObjectsInGet ?? 500;
    switch (name) {
      case "Mailbox/get":
        return { list: this.mailboxes };
      case "Mailbox/query": {
        const role = (args.filter as { role?: string })?.role;
        return { ids: this.mailboxes.filter((m) => !role || m.role === role).map((m) => m.id) };
      }
      case "Email/query": {
        // RFC 8621: `after` is inclusive, `before` is strict.
        const f = args.filter as { inMailbox?: string; after?: string; before?: string };
        let list = this.emails.filter(
          (e) => (!f.inMailbox || e.mailboxIds[f.inMailbox]) && (!f.after || e.receivedAt >= f.after) && (!f.before || e.receivedAt < f.before),
        );
        const ascending = (args.sort as { isAscending?: boolean }[] | undefined)?.[0]?.isAscending === true;
        // Stable, so equal timestamps keep insertion order.
        list = [...list].sort((a, b) => (ascending ? a.receivedAt.localeCompare(b.receivedAt) : b.receivedAt.localeCompare(a.receivedAt)));
        const position = Number(args.position ?? 0);
        const limit = Math.min(Number(args.limit ?? 1000), this.opts.queryLimitCap ?? Infinity);
        return {
          ids: list.slice(position, position + limit).map((e) => e.id),
          ...(args.calculateTotal ? { total: list.length } : {}),
        };
      }
      case "Email/get": {
        const ids = args.ids as string[];
        if (ids.length > max) throw new Error("requestTooLarge");
        const props = args.properties as string[];
        return { list: ids.map((id) => this.emails.find((e) => e.id === id)).filter(Boolean).map((e) => this.project(e!, props)) };
      }
      case "Thread/get": {
        const ids = args.ids as string[];
        if (ids.length > max) throw new Error("requestTooLarge");
        return { list: ids.map((t) => ({ id: t, emailIds: this.emails.filter((e) => e.threadId === t).map((e) => e.id) })) };
      }
      case "Email/set": {
        if (readOnly) throw new Error("accountReadOnly");
        if ("destroy" in args) throw new Error("test server refuses destroy");
        const notUpdated: Record<string, unknown> = {};
        const updated: Record<string, null> = {};
        for (const [id, patch] of Object.entries((args.update ?? {}) as Record<string, Record<string, unknown>>)) {
          const e = this.emails.find((x) => x.id === id);
          if (!e) {
            notUpdated[id] = { type: "notFound" };
            continue;
          }
          for (const [path, value] of Object.entries(patch)) {
            const m = /^mailboxIds\/(.+)$/.exec(path);
            if (!m) throw new Error(`unexpected patch ${path}`);
            if (value === null) delete e.mailboxIds[m[1]!];
            else e.mailboxIds[m[1]!] = true;
          }
          updated[id] = null;
        }
        const created: Record<string, unknown> = {};
        for (const [cid, obj] of Object.entries((args.create ?? {}) as Record<string, Record<string, unknown>>)) {
          this.created.push(obj);
          created[cid] = { id: `new${this.nextId++}` };
        }
        return { updated, notUpdated, created };
      }
      default:
        throw new Error("unknownMethod");
    }
  }

  private project(e: FakeEmail, props: string[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const p of props) {
      const h = /^header:([^:]+):asText(:all)?$/.exec(p);
      if (h) {
        const values = e.headers?.[h[1]!.toLowerCase()] ?? [];
        out[p] = h[2] ? values : (values.at(-1) ?? null);
      } else {
        out[p] = (e as unknown as Record<string, unknown>)[p] ?? null;
      }
    }
    return out;
  }
}

let seq = 0;
export function spamEmail(partial: Omit<Partial<FakeEmail>, "from"> & { from: string; subject: string; daysAgo?: number; name?: string }, now = new Date("2026-11-23T20:00:00Z")): FakeEmail {
  seq++;
  const { daysAgo = 1, name, from, ...rest } = partial;
  return {
    id: `M${seq}`,
    threadId: `T${seq}`,
    mailboxIds: { "mb-junk": true },
    from: [{ name: name ?? null, email: from }],
    receivedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    preview: "",
    ...rest,
  };
}

export function sentEmail(
  to: string,
  daysAgo: number,
  from = "owner@owner.example",
  now = new Date("2026-11-23T20:00:00Z"),
  extra: Partial<FakeEmail> = {},
): FakeEmail {
  seq++;
  return {
    id: `S${seq}`,
    threadId: `ST${seq}`,
    mailboxIds: { "mb-sent": true },
    from: [{ email: from }],
    to: [{ email: to }],
    subject: "Hello",
    inReplyTo: null,
    references: null,
    receivedAt: new Date(now.getTime() - daysAgo * 86_400_000).toISOString(),
    ...extra,
  };
}

/** A reply you sent, in the given thread. */
export function sentReply(to: string, threadId: string, daysAgo: number): FakeEmail {
  return sentEmail(to, daysAgo, undefined, undefined, { threadId, subject: "Re: your offer", inReplyTo: ["<spam-1@spam.example>"], references: ["<spam-1@spam.example>"] });
}

// ---------------------------------------------------------------- fake AI

export type Judge = (m: PromptMessage, key: string) => { choice: Category; probabilities: Record<Category, number> } | null;

/** Even split, with `top` getting `p`. */
export function dist(top: Category, p = 0.8): Record<Category, number> {
  const rest = (1 - p) / (CATEGORIES.length - 1);
  return Object.fromEntries(CATEGORIES.map((c) => [c, c === top ? p : rest])) as Record<Category, number>;
}

/** Messages in a payload, keyed by label. */
export function payloadMessages(payload: string): Map<string, PromptMessage> {
  const out = new Map<string, PromptMessage>();
  for (const line of payload.split("\n")) {
    const m = /^\[(m\d+)\] (\{.*\})$/.exec(line);
    if (m) out.set(m[1]!, JSON.parse(m[2]!));
  }
  return out;
}

/**
 * A Workers AI binding that answers like the real endpoints, in each model's
 * own response shape, using `judge` for the decision.
 */
export class FakeAi implements AiBinding {
  calls: { model: string; input: Record<string, unknown>; options: unknown }[] = [];
  judge: Judge;
  failWith?: Error;
  constructor(judge: Judge = () => ({ choice: "spam", probabilities: dist("spam", 0.9) })) {
    this.judge = judge;
  }
  async run(model: string, input: unknown, options?: unknown): Promise<unknown> {
    const i = input as Record<string, unknown>;
    this.calls.push({ model, input: i, options });
    if (this.failWith) throw this.failWith;
    const payload = String(i.state ?? i.input);
    const messages = payloadMessages(payload);
    if (model === "openai/decisions") {
      const answers = (i.questions as { name: string; type: string }[]).map((q) => {
        const v = this.judge(messages.get(q.name)!, q.name);
        if (!v) return { name: q.name, type: "refusal" };
        if (q.type === "predicate") return { name: q.name, type: "predicate", probability: 1 - v.probabilities.spam };
        return {
          name: q.name,
          type: "choice",
          choice: v.choice,
          confidence: v.probabilities[v.choice],
          probabilities: CATEGORIES.map((c) => ({ value: c, probability: v.probabilities[c] })),
        };
      });
      return { model: "gpt-6-luna", answers, usage: { input_tokens: 100, output_tokens: 0 } };
    }
    const answers: Record<string, unknown> = {};
    for (const [key, q] of Object.entries(i.questions as Record<string, { type: string }>)) {
      const v = this.judge(messages.get(key)!, key);
      if (!v) continue;
      if (q.type === "noul") {
        const p = 1 - v.probabilities.spam;
        answers[key] = model.startsWith("google/") ? { type: "noul", noul: p, confidence: 0.9 } : { type: "noul", noul: p };
      } else answers[key] = { type: "choice", choice: v.choice, confidence: v.probabilities[v.choice], probabilities: v.probabilities };
    }
    // Gemini answers through the binding inside a job envelope (observed in production).
    return model.startsWith("google/")
      ? { state: "Completed", result: { answers, usage: { total_input_tokens: 100, total_output_tokens: 0 } } }
      : { model: "clef", answers, usage: { input_tokens: 100, output_tokens: 0 } };
  }
}
