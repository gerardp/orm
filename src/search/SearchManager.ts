import { Model } from "../model/Model.js";
import type { ModelConstructor } from "../model/Model.js";
import type { SearchEngine, SearchMultiResult, SearchableRecord } from "./SearchEngine.js";
import type { SearchBuilder } from "./SearchBuilder.js";
import { attachSearchObserver, detachSearchObservers } from "./SearchObserver.js";
import {
  applySearchableStatics,
  type SearchableInstance,
  type SearchableModelConstructor,
  type SearchableModelStatics,
  type SearchableOptions,
} from "./Searchable.js";

export interface SearchBatchConfig {
  /** Flush when this many distinct records have accumulated. */
  maxItems?: number;
  /** Flush after this many milliseconds since the first buffered record. */
  maxMs?: number;
}

export interface SearchConfig {
  engine: SearchEngine;
  queue?: { connection?: string; name?: string };
  chunk?: number;
  batch?: SearchBatchConfig;
  /**
   * When set, every call to `Model.searchableAs()` runs through this hook
   * to produce a tenant-scoped index name (e.g. `posts_tenant_42`). The
   * hook receives the base index name (`searchIndex ?? getTable()`) and the
   * active tenant id from `TenantContext.current()`. Return the base name
   * unchanged for tenants that should share the global index, or null tenants.
   *
   * Example:
   * ```ts
   * tenantScope: (base, tenantId) => tenantId ? `${base}_t_${tenantId}` : base
   * ```
   *
   * The resolved name is baked into `SearchableRecord.index` at observer
   * dispatch time, and read by `SearchBuilder` at query time, so both the
   * sync side (observer/queue) and the read side (search) stay aligned.
   */
  tenantScope?: (baseIndex: string, tenantId: string | null) => string;

  /**
   * Source of tenant ids for batch operations (`Search.indexesForAllTenants`,
   * `search:list-indexes --all-tenants`). Typically wired from
   * `BunnyConfig.tenancy.listTenants` at configure time.
   */
  listTenants?: () => string[] | Promise<string[]>;
}

let currentConfig: SearchConfig | null = null;
const observed = new Set<ModelConstructor>();
const pending = new Set<ModelConstructor>();

// Batch coalescing state — opt-in via `SearchConfig.batch`.
const pendingUpdates = new Map<string, SearchableRecord>();
const pendingDeletes = new Map<string, SearchableRecord>();
let batchTimer: ReturnType<typeof setTimeout> | null = null;
let exitHookInstalled = false;

function recordKey(r: SearchableRecord): string {
  return `${r.index}:${r.id}`;
}

function batchingEnabled(): boolean {
  return Boolean(currentConfig?.batch && !currentConfig.queue);
}

function scheduleFlush(): void {
  if (batchTimer || !currentConfig?.batch) return;
  const maxMs = currentConfig.batch.maxMs ?? 500;
  batchTimer = setTimeout(() => { void flushPending(); }, maxMs);
}

function totalBuffered(): number {
  return pendingUpdates.size + pendingDeletes.size;
}

function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  if (typeof process !== "undefined" && typeof process.once === "function") {
    process.once("beforeExit", () => { void flushPending().catch(() => {}); });
  }
}

async function flushPending(): Promise<void> {
  if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
  if (pendingUpdates.size === 0 && pendingDeletes.size === 0) return;
  const updates = [...pendingUpdates.values()];
  const deletes = [...pendingDeletes.values()];
  pendingUpdates.clear();
  pendingDeletes.clear();
  const engine = currentConfig?.engine;
  if (!engine) return;
  if (updates.length > 0) await engine.update(updates);
  if (deletes.length > 0) await engine.delete(deletes);
}

function attachIfReady(modelClass: ModelConstructor): void {
  if (observed.has(modelClass)) return;
  if (currentConfig) {
    attachSearchObserver(modelClass);
    observed.add(modelClass);
  } else {
    pending.add(modelClass);
  }
}

export const Search = {
  configure(config: SearchConfig): void {
    currentConfig = config;
    for (const m of pending) {
      attachSearchObserver(m);
      observed.add(m);
    }
    pending.clear();
    if (config.batch) installExitHook();
  },

  /** True when `SearchConfig.batch` is set and queue mode is off. */
  isBatching(): boolean {
    return batchingEnabled();
  },

  /** Queue a record for batched update. Returns true if buffered, false if caller should dispatch immediately. */
  enqueueUpdate(record: SearchableRecord): boolean {
    if (!batchingEnabled()) return false;
    const key = recordKey(record);
    pendingDeletes.delete(key);
    pendingUpdates.set(key, record);
    const max = currentConfig?.batch?.maxItems ?? 100;
    if (totalBuffered() >= max) {
      void flushPending();
    } else {
      scheduleFlush();
    }
    return true;
  },

  /** Queue a record for batched delete. */
  enqueueDelete(record: SearchableRecord): boolean {
    if (!batchingEnabled()) return false;
    const key = recordKey(record);
    pendingUpdates.delete(key);
    pendingDeletes.set(key, record);
    const max = currentConfig?.batch?.maxItems ?? 100;
    if (totalBuffered() >= max) {
      void flushPending();
    } else {
      scheduleFlush();
    }
    return true;
  },

  /** Manually flush the batch buffer (also called on process beforeExit). */
  async flushPending(): Promise<void> {
    await flushPending();
  },

  register<TBase extends ModelConstructor>(
    modelClass: TBase,
    options: SearchableOptions<InstanceType<TBase>> = {},
  ): TBase
    & SearchableModelStatics<InstanceType<TBase>>
    & { new (...args: any[]): InstanceType<TBase> & SearchableInstance } {
    applySearchableStatics<InstanceType<TBase>>(modelClass, options);
    attachIfReady(modelClass);
    return modelClass as any;
  },

  /**
   * Define a searchable model in one call. Combines `Model.define()` +
   * `applySearchableStatics()` + lazy observer registration. Observer attaches
   * automatically once `Search.configure()` is called.
   */
  define<A extends Record<string, any>>(
    tableName: string,
    options: SearchableOptions<Model<A> & A> = {},
  ): ReturnType<typeof Model.define<A>>
    & SearchableModelStatics<Model<A> & A>
    & { new (...args: any[]): Model<A> & A & SearchableInstance } {
    const Base = Model.define<A>(tableName) as any;
    applySearchableStatics(Base, options);
    attachIfReady(Base);
    return Base;
  },

  unregister(modelClass: ModelConstructor): void {
    if (!observed.has(modelClass)) return;
    detachSearchObservers(modelClass);
    observed.delete(modelClass);
  },

  engine(): SearchEngine {
    if (!currentConfig) {
      throw new Error("Search not configured. Pass `search` to configureBunny() or call Search.configure().");
    }
    return currentConfig.engine;
  },

  config(): SearchConfig | null {
    return currentConfig;
  },

  /**
   * Resolve a base index name through the configured tenant scoper. Reads
   * the active `TenantContext` when `tenantId` is omitted. Use this from
   * CLI/scripts that need the tenant-scoped name outside a model context.
   */
  indexFor(baseIndex: string, tenantId?: string | null): string {
    const cfg = currentConfig;
    if (!cfg?.tenantScope) return baseIndex;
    let active: string | null;
    if (tenantId === undefined) {
      try {
        const { TenantContext } = require("../connection/TenantContext.js");
        active = TenantContext.current()?.tenantId ?? null;
      } catch {
        active = null;
      }
    } else {
      active = tenantId;
    }
    return cfg.tenantScope(baseIndex, active);
  },

  /**
   * Batch variant of `indexFor()`. Resolves a base index name across many
   * tenants in one call. Pass `null` to include the landlord (un-scoped)
   * variant in the result map.
   *
   * ```ts
   * Search.indexesFor("posts", ["1", "2", null]);
   * // → { "1": "posts_t_1", "2": "posts_t_2", "__landlord__": "posts" }
   * ```
   */
  indexesFor(
    baseIndex: string,
    tenantIds: ReadonlyArray<string | null>,
  ): Record<string, string> {
    const cfg = currentConfig;
    const out: Record<string, string> = {};
    for (const tid of tenantIds) {
      const key = tid === null ? "__landlord__" : tid;
      out[key] = cfg?.tenantScope ? cfg.tenantScope(baseIndex, tid) : baseIndex;
    }
    return out;
  },

  /**
   * Resolve the scoped index name for every tenant returned by
   * `tenancy.listTenants` (configured on `configureBunny`). Includes the
   * landlord variant when `includeLandlord` is true.
   */
  async indexesForAllTenants(
    baseIndex: string,
    options: { includeLandlord?: boolean } = {},
  ): Promise<Record<string, string>> {
    const cfg = currentConfig;
    const tenantIds: string[] = cfg?.listTenants ? ((await cfg.listTenants()) ?? []) : [];
    const inputs: Array<string | null> = options.includeLandlord ? [null, ...tenantIds] : [...tenantIds];
    return this.indexesFor(baseIndex, inputs);
  },

  /**
   * Execute several search queries in a single round-trip. Returns raw hits
   * per builder (no ORM hydration). Falls back to sequential `engine.search()`
   * when the engine has no native `multiSearch`.
   */
  async multi(builders: SearchBuilder<any>[]): Promise<SearchMultiResult[]> {
    if (builders.length === 0) return [];
    const queries = builders.map((b) => (b as any)._toQuery());
    const engine = Search.engine();
    if (typeof engine.multiSearch === "function") {
      return engine.multiSearch(queries);
    }
    const results: SearchMultiResult[] = [];
    for (const q of queries) {
      const hits = await engine.search(q);
      results.push({ index: q.index, hits });
    }
    return results;
  },

  reset(): void {
    for (const m of observed) detachSearchObservers(m);
    observed.clear();
    pending.clear();
    if (batchTimer) { clearTimeout(batchTimer); batchTimer = null; }
    pendingUpdates.clear();
    pendingDeletes.clear();
    currentConfig = null;
  },
};

export function getSearchEngine(): SearchEngine {
  return Search.engine();
}

export function getSearchConfig(): SearchConfig | null {
  return currentConfig;
}
