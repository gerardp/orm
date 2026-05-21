import { createHmac } from "node:crypto";
import type {
  FacetDistribution,
  MatchPosition,
  SearchEngine,
  SearchFilter,
  SearchHealth,
  SearchHit,
  SearchMultiResult,
  SearchPage,
  SearchQuery,
  SearchTaskStatus,
  SearchableRecord,
} from "../SearchEngine.js";
import {
  InvalidMeilisearchSettingsError,
  validateMeilisearchSettings,
} from "../MeilisearchSettingsSchema.js";

export interface MeilisearchEngineOptions {
  host: string;
  apiKey?: string;
  requestTimeoutMs?: number;
  primaryKey?: string;
  fetch?: typeof fetch;
  /** Validate index settings keys against the known Meilisearch schema (default true). */
  validate?: boolean;
  /** When true, every write op polls until the resulting task settles. */
  waitForTasks?: boolean;
  /** Default wait timeout for `waitForTasks` + explicit waitForTask calls. */
  taskTimeoutMs?: number;
  /** Poll interval for task status checks. */
  taskPollMs?: number;
}

export interface TenantTokenOptions {
  /**
   * Parent API key used to sign the JWT. Defaults to the engine's `apiKey`.
   * Must be a Meilisearch API key with the `search` action and the index
   * patterns the tenant rules cover.
   */
  apiKey?: string;
  /** Required: UID of the parent API key — fetch via `engine.getApiKey()`. */
  apiKeyUid: string;
  /** Optional expiry — Date or unix-seconds. */
  expiresAt?: Date | number;
}

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input) : input;
  return buf.toString("base64").replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

interface MeiliSearchResponse {
  hits: Array<Record<string, unknown>>;
  estimatedTotalHits?: number;
  totalHits?: number;
  hitsPerPage?: number;
  page?: number;
  facetDistribution?: FacetDistribution;
}

interface MeiliTaskEnvelope {
  taskUid?: number;
  uid?: number;
  status?: string;
  type?: string;
  error?: { message: string; code?: string };
}

interface MeiliMultiSearchResponse {
  results: Array<MeiliSearchResponse & { indexUid: string }>;
}

export class MeilisearchEngine implements SearchEngine {
  private host: string;
  private apiKey?: string;
  private timeoutMs: number;
  private primaryKey: string;
  private fetchImpl: typeof fetch;
  private validate: boolean;
  private waitForTasksDefault: boolean;
  private taskTimeoutMs: number;
  private taskPollMs: number;

  constructor(options: MeilisearchEngineOptions) {
    if (!options.host) throw new Error("MeilisearchEngine requires `host`.");
    this.host = options.host.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.requestTimeoutMs ?? 5000;
    this.primaryKey = options.primaryKey ?? "id";
    this.fetchImpl = options.fetch ?? fetch;
    this.validate = options.validate ?? true;
    this.waitForTasksDefault = options.waitForTasks === true;
    this.taskTimeoutMs = options.taskTimeoutMs ?? 30_000;
    this.taskPollMs = options.taskPollMs ?? 50;
  }

  async update(records: SearchableRecord[]): Promise<void> {
    if (records.length === 0) return;
    const byIndex = new Map<string, SearchableRecord[]>();
    for (const r of records) {
      const bucket = byIndex.get(r.index) ?? [];
      bucket.push(r);
      byIndex.set(r.index, bucket);
    }
    for (const [index, group] of byIndex) {
      const documents = group.map((r) => ({ ...r.data, [this.primaryKey]: r.id }));
      const res = await this.request<MeiliTaskEnvelope>("POST", `/indexes/${encodeURIComponent(index)}/documents?primaryKey=${encodeURIComponent(this.primaryKey)}`, documents);
      await this.maybeWait(res);
    }
  }

  async delete(records: SearchableRecord[]): Promise<void> {
    if (records.length === 0) return;
    const byIndex = new Map<string, Array<string | number>>();
    for (const r of records) {
      const bucket = byIndex.get(r.index) ?? [];
      bucket.push(r.id);
      byIndex.set(r.index, bucket);
    }
    for (const [index, ids] of byIndex) {
      const res = await this.request<MeiliTaskEnvelope>("POST", `/indexes/${encodeURIComponent(index)}/documents/delete-batch`, ids);
      await this.maybeWait(res);
    }
  }

  async search(query: SearchQuery): Promise<SearchHit[]> {
    const body = this.buildSearchBody(query);
    if (query.limit !== undefined) body.limit = query.limit;
    if (query.offset !== undefined) body.offset = query.offset;
    const res = await this.request<MeiliSearchResponse>("POST", `/indexes/${encodeURIComponent(query.index)}/search`, body);
    return this.toHits(res);
  }

  async paginate(query: SearchQuery, perPage: number, page: number): Promise<SearchPage> {
    const body = this.buildSearchBody(query);
    body.hitsPerPage = perPage;
    body.page = page;
    const res = await this.request<MeiliSearchResponse>("POST", `/indexes/${encodeURIComponent(query.index)}/search`, body);
    return {
      hits: this.toHits(res),
      total: res.totalHits ?? res.estimatedTotalHits ?? res.hits.length,
      page: res.page ?? page,
      perPage: res.hitsPerPage ?? perPage,
      facetDistribution: res.facetDistribution,
    };
  }

  async multiSearch(queries: SearchQuery[]): Promise<SearchMultiResult[]> {
    if (queries.length === 0) return [];
    const body = {
      queries: queries.map((q) => ({
        indexUid: q.index,
        ...this.buildSearchBody(q),
        ...(q.limit !== undefined ? { limit: q.limit } : {}),
        ...(q.offset !== undefined ? { offset: q.offset } : {}),
      })),
    };
    const res = await this.request<MeiliMultiSearchResponse>("POST", `/multi-search`, body);
    return res.results.map((r) => ({
      index: r.indexUid,
      hits: this.toHits(r),
      total: r.totalHits ?? r.estimatedTotalHits ?? r.hits.length,
      facetDistribution: r.facetDistribution,
    }));
  }

  async flush(index: string): Promise<void> {
    const res = await this.request<MeiliTaskEnvelope>("DELETE", `/indexes/${encodeURIComponent(index)}/documents`);
    await this.maybeWait(res);
  }

  async createIndex(name: string, options: Record<string, unknown> = {}): Promise<void> {
    const res = await this.request<MeiliTaskEnvelope>("POST", `/indexes`, { uid: name, primaryKey: options.primaryKey ?? this.primaryKey });
    await this.maybeWait(res);
  }

  async deleteIndex(name: string): Promise<void> {
    const res = await this.request<MeiliTaskEnvelope>("DELETE", `/indexes/${encodeURIComponent(name)}`);
    await this.maybeWait(res);
  }

  async updateIndexSettings(name: string, settings: Record<string, unknown>): Promise<void> {
    if (this.validate) {
      const result = validateMeilisearchSettings(settings);
      if (!result.ok) throw new InvalidMeilisearchSettingsError(result.unknown);
    }
    const res = await this.request<MeiliTaskEnvelope>("PATCH", `/indexes/${encodeURIComponent(name)}/settings`, settings);
    await this.maybeWait(res);
  }

  /** Atomically swap two indexes. The pair must both exist before swapping. */
  async swapIndexes(a: string, b: string): Promise<void> {
    const res = await this.request<MeiliTaskEnvelope>("POST", `/swap-indexes`, [{ indexes: [a, b] }]);
    await this.maybeWait(res);
  }

  /** Poll `/tasks/{uid}` until the task leaves enqueued/processing. */
  async waitForTask(
    uid: number,
    options: { timeoutMs?: number; pollMs?: number } = {},
  ): Promise<SearchTaskStatus> {
    const deadline = Date.now() + (options.timeoutMs ?? this.taskTimeoutMs);
    const poll = options.pollMs ?? this.taskPollMs;
    while (true) {
      const task = await this.request<any>("GET", `/tasks/${uid}`);
      const status = task.status as SearchTaskStatus["status"];
      if (status === "succeeded" || status === "failed" || status === "canceled") {
        const result: SearchTaskStatus = { uid, status, type: task.type, error: task.error };
        if (status === "failed") {
          throw new Error(`Meilisearch task ${uid} failed: ${task.error?.message ?? "unknown"}`);
        }
        return result;
      }
      if (Date.now() > deadline) {
        throw new Error(`Meilisearch task ${uid} did not settle within ${options.timeoutMs ?? this.taskTimeoutMs}ms (last status: ${status}).`);
      }
      await new Promise((r) => setTimeout(r, poll));
    }
  }

  /**
   * Generate a tenant-scoped JWT for client-side searches.
   * See: https://www.meilisearch.com/docs/reference/api/multitenancy
   *
   * ```ts
   * const token = await engine.createTenantToken(
   *   { "posts": { filter: "tenant_id = 42" } },
   *   { apiKeyUid: "abc-uid", expiresAt: new Date(Date.now() + 3600_000) },
   * );
   * ```
   */
  createTenantToken(
    searchRules: Record<string, unknown>,
    options: TenantTokenOptions,
  ): string {
    const signingKey = options.apiKey ?? this.apiKey;
    if (!signingKey) throw new Error("createTenantToken requires an API key (engine.apiKey or options.apiKey).");
    if (!options.apiKeyUid) throw new Error("createTenantToken requires options.apiKeyUid (fetch via getApiKey()).");
    const payload: Record<string, unknown> = {
      searchRules,
      apiKeyUid: options.apiKeyUid,
    };
    if (options.expiresAt) {
      const exp = options.expiresAt instanceof Date
        ? Math.floor(options.expiresAt.getTime() / 1000)
        : options.expiresAt;
      payload.exp = exp;
    }
    const header = { alg: "HS256", typ: "JWT" };
    const h = base64UrlEncode(JSON.stringify(header));
    const p = base64UrlEncode(JSON.stringify(payload));
    const data = `${h}.${p}`;
    const sig = createHmac("sha256", signingKey).update(data).digest();
    return `${data}.${base64UrlEncode(sig)}`;
  }

  /** Fetch the API key record (includes `uid` for tenant token signing). */
  async getApiKey(key?: string): Promise<{ uid: string; name?: string; actions?: string[]; indexes?: string[] }> {
    const target = key ?? this.apiKey;
    if (!target) throw new Error("getApiKey requires an API key.");
    return await this.request("GET", `/keys/${encodeURIComponent(target)}`);
  }

  async indexExists(name: string): Promise<boolean> {
    try {
      await this.request("GET", `/indexes/${encodeURIComponent(name)}`);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/\b404\b/.test(message)) return false;
      throw err;
    }
  }

  async health(): Promise<SearchHealth> {
    const res = await this.request<{ status: string }>("GET", `/health`);
    return { status: res.status, details: res };
  }

  private buildSearchBody(query: SearchQuery): Record<string, unknown> {
    const body: Record<string, unknown> = { q: query.query };
    const filter = this.compileFilters(query.filters);
    if (filter) body.filter = filter;
    const sorts: string[] = [];
    if (query.geoSort) {
      const dir = query.geoSort.direction ?? "asc";
      sorts.push(`_geoPoint(${query.geoSort.lat},${query.geoSort.lng}):${dir}`);
    }
    if (query.sorts.length > 0) {
      for (const s of query.sorts) sorts.push(`${s.field}:${s.direction}`);
    }
    if (sorts.length > 0) body.sort = sorts;
    if (query.vector && query.vector.length > 0) body.vector = query.vector;
    if (query.hybrid) {
      const hybrid: Record<string, unknown> = {};
      if (query.hybrid.semanticRatio !== undefined) hybrid.semanticRatio = query.hybrid.semanticRatio;
      if (query.hybrid.embedder !== undefined) hybrid.embedder = query.hybrid.embedder;
      if (Object.keys(hybrid).length > 0) body.hybrid = hybrid;
    }
    if (query.facets && query.facets.length > 0) body.facets = query.facets;
    if (query.minScore !== undefined) body.rankingScoreThreshold = query.minScore;
    if (query.attributesToSearchOn && query.attributesToSearchOn.length > 0) {
      body.attributesToSearchOn = query.attributesToSearchOn;
    }
    if (query.highlight) {
      body.attributesToHighlight = query.highlight.fields;
      if (query.highlight.preTag !== undefined) body.highlightPreTag = query.highlight.preTag;
      if (query.highlight.postTag !== undefined) body.highlightPostTag = query.highlight.postTag;
    }
    if (query.crop && query.crop.length > 0) {
      body.attributesToCrop = query.crop.map((c) => c.length !== undefined ? `${c.field}:${c.length}` : c.field);
    }
    if (query.showRankingScore) body.showRankingScore = true;
    return body;
  }

  private compileFilters(filters: SearchFilter[]): string | undefined {
    if (filters.length === 0) return undefined;
    return this.joinFilters(filters);
  }

  private joinFilters(filters: SearchFilter[]): string {
    let out = "";
    filters.forEach((f, i) => {
      const expr = this.compileFilter(f);
      if (i === 0) out = expr;
      else out += ` ${f.bool === "or" ? "OR" : "AND"} ${expr}`;
    });
    return out;
  }

  private compileFilter(f: SearchFilter): string {
    switch (f.kind) {
      case "cmp":
        return `${f.field} ${f.op} ${this.literal(f.value)}`;
      case "in": {
        const list = `${f.field} IN [${f.values.map((v) => this.literal(v)).join(",")}]`;
        return f.negate ? `NOT ${list}` : list;
      }
      case "between": {
        const expr = `${f.field} ${this.literal(f.from)} TO ${this.literal(f.to)}`;
        return f.negate ? `NOT ${expr}` : expr;
      }
      case "null": {
        const expr = `${f.field} IS NULL`;
        return f.negate ? `${f.field} IS NOT NULL` : expr;
      }
      case "exists": {
        const expr = `${f.field} EXISTS`;
        return f.negate ? `${f.field} NOT EXISTS` : expr;
      }
      case "group": {
        const inner = this.joinFilters(f.filters);
        const wrapped = `(${inner})`;
        return f.negate ? `NOT ${wrapped}` : wrapped;
      }
      case "raw":
        return f.expr;
    }
  }

  private literal(value: unknown): string {
    if (value === null || value === undefined) return "null";
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return `"${String(value).replace(/"/g, '\\"')}"`;
  }

  private toHits(res: MeiliSearchResponse): SearchHit[] {
    return res.hits.map((doc) => {
      const id = doc[this.primaryKey] as string | number;
      const hit: SearchHit = { id, data: doc };
      const score = (doc as any)._rankingScore;
      if (typeof score === "number") hit.score = score;
      const formatted = (doc as any)._formatted;
      if (formatted && typeof formatted === "object") hit.formatted = formatted as Record<string, unknown>;
      const matches = (doc as any)._matchesPosition;
      if (matches && typeof matches === "object") {
        hit.matchesPosition = matches as Record<string, MatchPosition[]>;
      }
      return hit;
    });
  }

  private async maybeWait(envelope: MeiliTaskEnvelope | undefined): Promise<void> {
    if (!this.waitForTasksDefault) return;
    if (!envelope) return;
    const uid = envelope.taskUid ?? envelope.uid;
    if (uid == null) return;
    await this.waitForTask(uid);
  }

  private async request<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.host}${path}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`Meilisearch ${method} ${path} failed: ${response.status} ${response.statusText} ${text}`);
    }

    if (response.status === 204) return undefined as T;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("application/json")) return undefined as T;
    return (await response.json()) as T;
  }
}
