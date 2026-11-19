/**
 * Minimal JMAP client (RFC 8620/8621) for Fastmail or any JMAP server.
 *
 * Reads the server's own limits from the session (maxCallsInRequest,
 * maxObjectsInGet) instead of assuming them, and packs independent method
 * calls into as few HTTP requests as those limits allow.
 */
import type { Budget } from "../lib/budget.ts";

export const USING = ["urn:ietf:params:jmap:core", "urn:ietf:params:jmap:mail"];
const MAIL = "urn:ietf:params:jmap:mail";
const CORE = "urn:ietf:params:jmap:core";

export type Invocation = [name: string, args: Record<string, unknown>, callId: string];
export type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

export interface Session {
  apiUrl: string;
  accountId: string;
  /** Fastmail reports whether the token can change this account. */
  accountReadOnly: boolean | undefined;
  maxCallsInRequest: number;
  maxObjectsInGet: number;
}

export class JmapError extends Error {}

/** HTTP 401/403, or a session with no mail account: the token is the problem. */
export class JmapAuthError extends JmapError {}

export class JmapMethodError extends JmapError {
  readonly type: string;
  readonly callId: string;
  constructor(type: string, description: string | undefined, callId: string) {
    super(`JMAP ${callId} failed: ${type}${description ? ` (${description})` : ""}`);
    this.type = type;
    this.callId = callId;
  }
}

export interface JmapClientOptions {
  sessionUrl: string;
  token: string;
  fetchImpl?: FetchImpl;
  budget?: Budget;
}

export class JmapClient {
  private readonly opts: JmapClientOptions;
  private readonly fetchImpl: FetchImpl;
  private sessionPromise: Promise<Session> | undefined;

  constructor(opts: JmapClientOptions) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? ((i, init) => fetch(i, init));
  }

  session(): Promise<Session> {
    return (this.sessionPromise ??= this.loadSession());
  }

  private async http(url: string, init: RequestInit): Promise<unknown> {
    this.opts.budget?.take();
    const res = await this.fetchImpl(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.opts.token}` },
    });
    if (res.status === 401 || res.status === 403) {
      throw new JmapAuthError(`JMAP request rejected (HTTP ${res.status}): check the Fastmail API token is valid and has mail access`);
    }
    if (!res.ok) {
      // Status only: never echo request headers (they carry the token).
      throw new JmapError(`JMAP request failed: HTTP ${res.status}`);
    }
    return res.json();
  }

  private async loadSession(): Promise<Session> {
    const raw = (await this.http(this.opts.sessionUrl, { method: "GET" })) as {
      apiUrl?: string;
      primaryAccounts?: Record<string, string>;
      accounts?: Record<string, { isReadOnly?: boolean }>;
      capabilities?: Record<string, Record<string, unknown>>;
    };
    const accountId = raw.primaryAccounts?.[MAIL];
    if (!accountId) {
      throw new JmapAuthError("the Fastmail token has no mail account: create it with the Email scope ticked (and Read-only access on, for FASTMAIL_TOKEN)");
    }
    if (typeof raw.apiUrl !== "string" || !raw.apiUrl.startsWith("https://")) {
      throw new JmapError("JMAP session has no https apiUrl");
    }
    const core = raw.capabilities?.[CORE] ?? {};
    const positive = (v: unknown, fallback: number) => (typeof v === "number" && v > 0 ? Math.floor(v) : fallback);
    return {
      apiUrl: raw.apiUrl,
      accountId,
      accountReadOnly: raw.accounts?.[accountId]?.isReadOnly,
      // RFC 8620 suggested minimums are 16 and 500; use what the server says.
      maxCallsInRequest: positive(core.maxCallsInRequest, 16),
      maxObjectsInGet: positive(core.maxObjectsInGet, 500),
    };
  }

  /**
   * One HTTP request. Calls may back-reference each other. Throws on the first
   * method-level error. Returns responses keyed by call id.
   */
  async request(calls: Invocation[]): Promise<Map<string, Record<string, unknown>>> {
    const session = await this.session();
    if (calls.length > session.maxCallsInRequest) {
      throw new JmapError(`internal: ${calls.length} calls exceeds maxCallsInRequest ${session.maxCallsInRequest}`);
    }
    const body = (await this.http(session.apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ using: USING, methodCalls: calls }),
    })) as { methodResponses?: [string, Record<string, unknown>, string][] };
    const out = new Map<string, Record<string, unknown>>();
    for (const [name, args, callId] of body.methodResponses ?? []) {
      if (name === "error") {
        throw new JmapMethodError(String(args.type ?? "unknown"), typeof args.description === "string" ? args.description : undefined, callId);
      }
      if (!out.has(callId)) out.set(callId, args);
    }
    return out;
  }

  /** Independent calls (no back-references), packed into as few requests as allowed. */
  async requestMany(calls: Invocation[]): Promise<Map<string, Record<string, unknown>>> {
    const { maxCallsInRequest } = await this.session();
    const out = new Map<string, Record<string, unknown>>();
    for (const group of chunk(calls, maxCallsInRequest)) {
      for (const [k, v] of await this.request(group)) out.set(k, v);
    }
    return out;
  }

  /** `X/get` for many ids, chunked by maxObjectsInGet. Returns the merged `list`. */
  async getMany(method: string, ids: string[], properties: string[]): Promise<Record<string, unknown>[]> {
    if (!ids.length) return [];
    const { accountId, maxObjectsInGet } = await this.session();
    const calls: Invocation[] = chunk(ids, maxObjectsInGet).map((part, i) => [method, { accountId, ids: part, properties }, `g${i}`]);
    const responses = await this.requestMany(calls);
    const list: Record<string, unknown>[] = [];
    for (const r of responses.values()) list.push(...((r.list as Record<string, unknown>[] | undefined) ?? []));
    return list;
  }

  /**
   * `Email/query` ids, paging with `position` until `max` ids or the end.
   * Servers may cap `limit`, so the page size is whatever they return.
   */
  async queryEmailIds(filter: Record<string, unknown>, max: number): Promise<{ ids: string[]; total?: number }> {
    const { accountId } = await this.session();
    const ids: string[] = [];
    let total: number | undefined;
    while (ids.length < max) {
      const res = await this.request([
        [
          "Email/query",
          {
            accountId,
            filter,
            sort: [{ property: "receivedAt", isAscending: false }],
            position: ids.length,
            limit: max - ids.length,
            calculateTotal: ids.length === 0,
          },
          "q",
        ],
      ]);
      const q = res.get("q") ?? {};
      if (typeof q.total === "number") total = q.total;
      const page = (q.ids as string[] | undefined) ?? [];
      ids.push(...page);
      if (!page.length || (total !== undefined && ids.length >= total)) break;
    }
    return { ids: ids.slice(0, max), total };
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
