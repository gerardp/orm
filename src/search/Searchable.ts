import type { Model, ModelConstructor } from "../model/Model.js";
import { TenantContext } from "../connection/TenantContext.js";
import { SearchBuilder } from "./SearchBuilder.js";
import { getSearchConfig, getSearchEngine } from "./SearchManager.js";
import type { SearchableRecord } from "./SearchEngine.js";

export interface SearchableOptions<M extends Model = Model> {
  index?: string;
  settings?: Record<string, unknown>;
  toSearchableArray?(model: M): Record<string, unknown>;
  shouldBeSearchable?(model: M): boolean;
  /**
   * Engine-specific schema hint. Currently consumed by `SqliteFTS5Engine` —
   * the `search:create-index` CLI auto-applies it via `engine.configureIndex()`.
   * Shape varies per engine; kept as opaque `Record<string, unknown>` here so
   * the core type doesn't import engine modules.
   */
  fts?: Record<string, unknown>;
}

export interface SearchableInstance {
  searchable(): Promise<void>;
  unsearchable(): Promise<void>;
}

export interface SearchableModelStatics<M = Model> {
  searchable: true;
  searchIndex?: string;
  searchIndexSettings?: Record<string, unknown>;
  searchFtsConfig?: Record<string, unknown>;
  toSearchableArray(model: M): Record<string, unknown>;
  shouldBeSearchable(model: M): boolean;
  searchableAs(): string;
  search(query: string): SearchBuilder<M>;
  makeAllSearchable(chunk?: number): Promise<void>;
  removeAllFromSearch(): Promise<void>;
}

export type SearchableModelConstructor<M = Model> =
  ModelConstructor & SearchableModelStatics<M>;

function defaultToSearchableArray(model: Model): Record<string, unknown> {
  return (model as any).toJSON ? (model as any).toJSON() : { ...(model as any).$attributes };
}

export function applySearchableStatics<M extends Model>(
  modelClass: ModelConstructor,
  options: SearchableOptions<M> = {},
): SearchableModelConstructor<M> {
  const ctor = modelClass as any;
  if (ctor.searchable === true && ctor.__searchableApplied) {
    return ctor as SearchableModelConstructor<M>;
  }

  ctor.searchable = true;
  ctor.__searchableApplied = true;

  if (options.index !== undefined) ctor.searchIndex = options.index;
  if (options.settings !== undefined) ctor.searchIndexSettings = options.settings;
  if (options.fts !== undefined) ctor.searchFtsConfig = options.fts;

  if (typeof ctor.searchableAs !== "function") {
    ctor.searchableAs = function (): string {
      const base = this.searchIndex ?? this.getTable();
      const cfg = getSearchConfig();
      if (!cfg?.tenantScope) return base;
      const tenantId = TenantContext.current()?.tenantId ?? null;
      return cfg.tenantScope(base, tenantId);
    };
  }

  if (options.toSearchableArray) {
    ctor.toSearchableArray = options.toSearchableArray;
  } else if (typeof ctor.toSearchableArray !== "function") {
    ctor.toSearchableArray = defaultToSearchableArray;
  }

  if (options.shouldBeSearchable) {
    ctor.shouldBeSearchable = options.shouldBeSearchable;
  } else if (typeof ctor.shouldBeSearchable !== "function") {
    ctor.shouldBeSearchable = () => true;
  }

  if (typeof ctor.search !== "function") {
    ctor.search = function (query: string) {
      return new SearchBuilder(this, query);
    };
  }

  if (typeof ctor.prototype.searchable !== "function") {
    ctor.prototype.searchable = async function (): Promise<void> {
      const record = makeSearchableRecord(this);
      if (record) await getSearchEngine().update([record]);
    };
  }
  if (typeof ctor.prototype.unsearchable !== "function") {
    ctor.prototype.unsearchable = async function (): Promise<void> {
      const record = makeSearchableRecord(this);
      if (record) await getSearchEngine().delete([record]);
    };
  }

  if (typeof ctor.makeAllSearchable !== "function") {
    ctor.makeAllSearchable = async function (chunk = 500): Promise<void> {
      const engine = getSearchEngine();
      await this.query().chunk(chunk, async (items: any) => {
        const rows = typeof items.all === "function" ? items.all() : items;
        const records = rows.map((m: any) => makeSearchableRecord(m)).filter(Boolean);
        if (records.length > 0) await engine.update(records);
      });
    };
  }
  if (typeof ctor.removeAllFromSearch !== "function") {
    ctor.removeAllFromSearch = async function (): Promise<void> {
      await getSearchEngine().flush(this.searchableAs());
    };
  }

  return ctor as SearchableModelConstructor<M>;
}

export function makeSearchableRecord(model: Model): SearchableRecord | null {
  const ctor = Object.getPrototypeOf(model).constructor as SearchableModelConstructor;
  if (!ctor.searchable) return null;
  const data = ctor.toSearchableArray
    ? ctor.toSearchableArray(model)
    : defaultToSearchableArray(model);
  const pk = (ctor as unknown as { primaryKey: string }).primaryKey;
  const id = (model as any).getAttribute(pk);
  if (id == null) return null;
  return { index: ctor.searchableAs(), id, data };
}

/**
 * Optional mixin for explicit class-syntax setup.
 * Equivalent to calling `Search.register(Model)` — useful when you want
 * static type completion for `Model.search(...)` without a cast.
 */
export function Searchable<TBase extends ModelConstructor>(
  Base: TBase,
  options: SearchableOptions = {},
): TBase
  & SearchableModelStatics<InstanceType<TBase>>
  & { new (...args: any[]): InstanceType<TBase> & SearchableInstance } {
  return applySearchableStatics(Base, options) as any;
}
