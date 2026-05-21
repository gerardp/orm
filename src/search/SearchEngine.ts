export interface SearchableRecord {
  index: string;
  id: string | number;
  data: Record<string, unknown>;
}

export interface MatchPosition {
  start: number;
  length: number;
}

export interface SearchHit {
  id: string | number;
  data: Record<string, unknown>;
  score?: number;
  formatted?: Record<string, unknown>;
  matchesPosition?: Record<string, MatchPosition[]>;
}

export type FacetDistribution = Record<string, Record<string, number>>;

export interface SearchPage {
  hits: SearchHit[];
  total: number;
  page: number;
  perPage: number;
  facetDistribution?: FacetDistribution;
}

export interface SearchSimplePage {
  hits: SearchHit[];
  page: number;
  perPage: number;
  hasMore: boolean;
}

export type CmpOp = "=" | "!=" | ">" | ">=" | "<" | "<=";

export type SearchFilter =
  | { kind: "cmp"; bool: "and" | "or"; field: string; op: CmpOp; value: unknown; negate?: boolean }
  | { kind: "in"; bool: "and" | "or"; field: string; values: unknown[]; negate?: boolean }
  | { kind: "between"; bool: "and" | "or"; field: string; from: unknown; to: unknown; negate?: boolean }
  | { kind: "null"; bool: "and" | "or"; field: string; negate?: boolean }
  | { kind: "exists"; bool: "and" | "or"; field: string; negate?: boolean }
  | { kind: "group"; bool: "and" | "or"; filters: SearchFilter[]; negate?: boolean }
  | { kind: "raw"; bool: "and" | "or"; expr: string; bindings?: readonly unknown[] };

export interface SearchSort {
  field: string;
  direction: "asc" | "desc";
}

export interface SearchGeoSort {
  lat: number;
  lng: number;
  direction?: "asc" | "desc";
}

export interface SearchHybrid {
  semanticRatio?: number;
  embedder?: string;
}

export interface SearchHighlight {
  fields: string[];
  preTag?: string;
  postTag?: string;
}

export interface SearchCrop {
  field: string;
  length?: number;
}

export interface FacetRange {
  field: string;
  buckets: number[];
  labels?: string[];
}

export interface SearchQuery {
  index: string;
  query: string;
  filters: SearchFilter[];
  sorts: SearchSort[];
  limit?: number;
  offset?: number;
  facets?: string[];
  facetRanges?: FacetRange[];
  minScore?: number;
  attributesToSearchOn?: string[];
  highlight?: SearchHighlight;
  crop?: SearchCrop[];
  showRankingScore?: boolean;
  /** When true, `query` is passed verbatim to the engine — no escaping. */
  rawQuery?: boolean;
  /** Per-column bm25 weights, applied in the order columns appear in the index. */
  bm25Weights?: number[];
  /** Vector search — embedding query vector. */
  vector?: number[];
  /** Hybrid search ratio + embedder name (Meilisearch). */
  hybrid?: SearchHybrid;
  /** Geo sort — emits `_geoPoint(lat,lng):dir` (Meilisearch). */
  geoSort?: SearchGeoSort;
}

export interface SearchMultiResult {
  index: string;
  hits: SearchHit[];
  total?: number;
  facetDistribution?: FacetDistribution;
}

export interface SearchHealth {
  status: string;
  details?: unknown;
}

export interface SearchTaskStatus {
  uid: number;
  status: "enqueued" | "processing" | "succeeded" | "failed" | "canceled" | string;
  type?: string;
  error?: { message: string; code?: string };
}

export interface SearchEngine {
  update(records: SearchableRecord[]): Promise<void>;
  delete(records: SearchableRecord[]): Promise<void>;
  search(query: SearchQuery): Promise<SearchHit[]>;
  paginate(query: SearchQuery, perPage: number, page: number): Promise<SearchPage>;
  flush(index: string): Promise<void>;
  createIndex(name: string, options?: Record<string, unknown>): Promise<void>;
  deleteIndex(name: string): Promise<void>;
  updateIndexSettings(name: string, settings: Record<string, unknown>): Promise<void>;
  health?(): Promise<SearchHealth>;
  multiSearch?(queries: SearchQuery[]): Promise<SearchMultiResult[]>;
  /** Returns true if the named index already exists in the engine. */
  indexExists?(name: string): Promise<boolean>;
  /** Wait for an engine-side task to terminate (Meilisearch). */
  waitForTask?(uid: number, options?: { timeoutMs?: number; pollMs?: number }): Promise<SearchTaskStatus>;
  /** Atomically swap two indexes (Meilisearch). */
  swapIndexes?(a: string, b: string): Promise<void>;
}
