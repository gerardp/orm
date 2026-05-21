# Search (Meilisearch)

`@bunnykit/orm/search` — Laravel Scout-inspired full-text search. v1 ships a Meilisearch engine. The `SearchEngine` interface stays driver-agnostic so additional engines (Algolia, Typesense, FlexSearch, Database, Collection) can drop in later.

## Install

Meilisearch must be reachable over HTTP. Local dev:

```bash
docker run -p 7700:7700 getmeili/meilisearch
```

No npm dep is required — the engine uses Bun's native `fetch`.

## Configure

Wire the engine into `configureBunny`:

```ts
import { configureBunny } from "@bunnykit/orm";
import { MeilisearchEngine } from "@bunnykit/orm/search";

configureBunny({
  connection: { url: "sqlite://app.db" },
  modelsPath: "./app/Models",
  search: {
    engine: new MeilisearchEngine({
      host: "http://127.0.0.1:7700",
      apiKey: process.env.MEILI_KEY,
    }),
    // Optional: dispatch sync as queued jobs instead of running inline.
    // queue: { name: "scout" },
    chunk: 500,
  },
});
```

Or configure outside the bunny facade:

```ts
import { Search, MeilisearchEngine } from "@bunnykit/orm/search";

Search.configure({ engine: new MeilisearchEngine({ host: "http://127.0.0.1:7700" }) });
```

## Make a model searchable

### Recommended — `Search.register()` on a base class

Keep the model declaration clean. Register it once to attach the observer and produce the searchable export.

```ts
// app/models/Post.ts
import { Model } from "@bunnykit/orm";
import { Search } from "@bunnykit/orm/search";

export interface PostAttributes {
  id: number;
  title: string;
  body: string;
  status: "draft" | "published";
}

class _Post extends Model.define<PostAttributes>("posts") {
  static fillable = ["title", "body", "status"];
}

export const Post = Search.register(_Post, {
  index: "posts_v2",
  settings: {
    filterableAttributes: ["status"],
    sortableAttributes: ["created_at"],
    searchableAttributes: ["title", "body"],
  },
  toSearchableArray: (m) => ({
    id: m.getAttribute("id"),
    title: m.getAttribute("title"),
    body: m.getAttribute("body"),
  }),
  shouldBeSearchable: (m) => m.getAttribute("status") === "published",
});

export type PostInstance = InstanceType<typeof Post>;
export default Post;
```

Default-export `Post` carries the full searchable constructor type. The companion `export type PostInstance` lets consumers annotate instances (`const p: PostInstance = ...`). The underscore-prefixed `_Post` stays local — it is the un-augmented base.

```ts
// consumer
import Post from "./app/models/Post";
import type { PostInstance } from "./app/models/Post";

const hits: PostInstance[] = await Post.search("rust").get();
```

Scaffold via CLI: `bunny make:searchable Post`.

### Alternative — `Search.define()`

Wrap an existing model class, add the searchable API, and register the
observer automatically.

```ts
import { Model } from "@bunnykit/orm";
import { Search } from "@bunnykit/orm/search";

class _Post extends Model.define<PostAttrs>("posts") {
  static fillable = ["title", "body", "status"];
}

export const Post = Search.define(_Post, { index: "posts_v2" });
export type PostInstance = InstanceType<typeof Post>;
export default Post;
```

The older one-call table shorthand is still supported:

```ts
export class Post extends Search.define<PostAttrs>("posts", { index: "posts_v2" }) {}
```

### Alternative — `Searchable` mixin

```ts
import { Searchable, Search } from "@bunnykit/orm/search";

export class Post extends Searchable(Model.define<PostAttrs>("posts"), { index: "posts_v2" }) {
  static fillable = ["title", "body", "status"];
}

Search.register(Post);   // mixin adds statics + types; this attaches the observer
```

### Settings validation

`searchIndexSettings` keys are validated against the Meilisearch schema before being pushed. Unknown keys throw `InvalidMeilisearchSettingsError`. Disable with `new MeilisearchEngine({ ..., validate: false })`.

Once registered, `Post.create()`, `post.save()`, and `post.delete()` automatically push to the index via the model observer. Soft-deleted rows are removed from the index.

Manual control:

```ts
await post.searchable();    // force-index this row
await post.unsearchable();  // remove from index
```

### Bulk path auto-sync

When any observer is registered for a model, these paths now fire observer events too:

- `Model.insert([...])` — routes through `saveMany()` to dispatch `created`/`saved` per row (one SQL INSERT per row; cost only paid when observers attached). Pass `{ events: false }` to opt out.
- `Model.where(...).update({...})` — pre-fetches matching IDs, runs the UPDATE, then dispatches `updated`/`saved` per affected row.
- `Model.where(...).delete()` — pre-fetches matching IDs, runs DELETE, then dispatches `deleted` per removed row.

Models without observers skip the extra `SELECT` entirely.

### Static helpers

`Search.register()` adds two static methods for full reindex / wipe:

```ts
await Post.makeAllSearchable(500);   // chunked bulk index — same shape as `search:import` CLI
await Post.removeAllFromSearch();    // wipe model's index
```

### Soft deletes

`Model.trashed()` returns `true` when `static softDeletes = true` and the `deleted_at` column is set on the instance. `SearchObserver` uses it to remove soft-deleted rows from the index automatically.

## Querying

```ts
const results = await Post.search("alpha").get();          // hydrated Post models
const top10   = await Post.search("alpha").take(10).get();
const rawHits = await Post.search("alpha").raw();          // skip hydration
```

### Filters

```ts
await Post.search("alpha")
  .where("status", "published")
  .where("rank", ">", 5)               // comparison ops: = != > >= < <=
  .whereNot("type", "draft")
  .whereIn("tag", ["tech", "news"])
  .whereNotIn("category", ["spam"])
  .whereBetween("price", [10, 99])
  .whereNotBetween("rank", [0, 1])
  .whereNull("deleted_at")
  .whereNotNull("published_at")
  .whereExists("title")
  .whereDoesntExist("archived_at")
  .whereRaw('_geoRadius(48, 2, 1000)')  // raw engine expression
  .orderBy("created_at", "desc")
  .get();
```

### OR + nested groups

```ts
await Post.search("alpha")
  .where("status", "published")
  .orWhere("featured", true)                   // OR sibling
  .where((q) => {                              // nested AND group
    q.where("rank", ">", 10).orWhere("priority", "high");
  })
  .get();
```

Every method has an `or*` variant: `orWhere`, `orWhereIn`, `orWhereNotIn`, `orWhereBetween`, `orWhereNotBetween`, `orWhereRaw`.

### Eager loading

```ts
const posts = await Post.search("alpha").with("author", "tags").get();
posts[0].author;   // loaded
```

Hydrated search results use the same `Collection` type as ORM queries.
`raw()` is the escape hatch when you want plain engine hits.

### Pagination

```ts
const page  = await Post.search("alpha").paginate(15, 2);
// { data: Collection<Post>, total, page, perPage }

const simple = await Post.search("alpha").simplePaginate(15, 2);
// { data: Collection<Post>, page, perPage, hasMore } — no total count query
```

### Streaming

```ts
for await (const post of Post.search("alpha").cursor(100)) {
  // streams pages of 100, yields one hydrated model at a time
}
```

Hits hydrate via a single `whereIn(primaryKey, ids)` query through the ORM. Casts, accessors, and `.with()` eager-loading all apply.

### Multi-sort (tie-breakers)

```ts
await Post.search("rust")
  .orderBy("rank", "desc")
  .thenBy("created_at", "desc")   // alias of orderBy, reads as a tie-breaker
  .get();
```

Sort fields apply left-to-right in array order.

### Facets

```ts
const page = await Post.search("rust")
  .facet("status")
  .facets("category", "language")   // variadic
  .paginate(15, 1);

page.facetDistribution;
// { status: { published: 42, draft: 7 }, category: { tech: 30, news: 19 }, ... }
```

Facets-only fetch (no hits):

```ts
const fd = await Post.search("").facet("status").facetDistribution();
// { status: { published: 42, draft: 7 } }
```

Sugar one-shot result with hits + total + facets:

```ts
const result = await Post.search("rust").facet("status").fetch(20);
// { data: Post[], total: 142, facetDistribution: { status: {...} } }
```

> Meilisearch requires each faceted field to be listed in `searchIndexSettings.filterableAttributes`.

### Score threshold

Drop low-relevance hits at query time:

```ts
const strong = await Post.search("rust").minScore(0.5).get();
```

Opt in to per-hit ranking scores:

```ts
const hits = await Post.search("rust").withScore().raw();
hits[0].score;   // number | undefined
```

Restrict raw hit fields for display/autocomplete payloads:

```ts
const hits = await Student.search("michelle")
  .searchOn("full_name")
  .retrieve("id", "full_name")
  .highlight("full_name")
  .raw();

hits[0].data;       // { id, full_name }
hits[0].formatted;  // highlighted fields, when supported by the engine
```

`.display()` is an alias of `.retrieve()`.

### Per-query field weighting (boost)

Restrict matching to a subset of indexed fields. Ranking ignores other fields for this query:

```ts
await Post.search("rust").searchOn("title").get();
await Post.search("rust").boost("title", "summary").get();  // alias of searchOn
```

### Highlight + crop + match positions

```ts
const hits = await Post.search("rust")
  .highlight("title", "body")
  .highlightTags("<mark>", "</mark>")
  .crop("body", 80)
  .raw();

hits[0].formatted;          // { title: "<mark>Rust</mark>...", body: "...<mark>Rust</mark>..." }
hits[0].matchesPosition;    // { title: [{ start: 0, length: 4 }], body: [...] }
```

### Multi-query search

Run multiple indexes / models in a single round-trip:

```ts
import { Search } from "@bunnykit/orm/search";

const [postResults, articleResults] = await Search.multi([
  Post.search("rust").take(5),
  Article.search("rust").take(5),
]);

postResults.index;            // "posts"
postResults.hits;             // SearchHit[]
postResults.total;            // 42
postResults.facetDistribution; // optional, if .facet() was used
```

Returns raw hits per builder — no ORM hydration. Hydrate manually with `Post.whereIn("id", postResults.hits.map(h => h.id)).get()` if needed. Falls back to sequential `engine.search()` calls when the engine has no native `multiSearch`.

## CLI

When `search` is configured, these commands register automatically:

| Command | Purpose |
|---|---|
| `bunny search:import <Model>` | Bulk-index all rows of a model (chunked). |
| `bunny search:flush <Model>` | Wipe the index for a model. |
| `bunny search:sync-index-settings [Model]` | Push `searchIndexSettings` to Meilisearch. |
| `bunny search:status` | Engine health + configured indexes. With `SqliteFTS5Engine`: SQLite pragmas (journal_mode, page_count, size, fragmentation %) + per-index row counts. |
| `bunny search:create-index <Model>` | Create the model's index. Auto-applies `Model.searchFtsConfig` via `engine.configureIndex()` when the engine supports it (SQLite FTS5). |
| `bunny search:delete-index <Model> --force` | Delete the model's index. `--force` required. |
| `bunny search:reimport <Model> [--chunk=N]` | Flush + bulk-import in one step. |
| `bunny search:import <Model> [--chunk=N] [--dry-run]` | `--dry-run` counts rows without pushing. |
| `bunny search:fts:optimize <Model>` | FTS5-only. Merges b-tree levels, reduces fragmentation. |
| `bunny search:fts:rebuild <Model>` | FTS5-only. Repopulates the index from the source content table. |
| `bunny search:list-indexes [--tenant=ID] [--tenants=A,B] [--all-tenants] [--include-landlord]` | Print the resolved index name per searchable model, optionally per-tenant. |
| `bunny search:verify [--tenant=ID] [--all-tenants] [--include-landlord] [--fix]` | Check that every searchable model's index exists on the engine. `--fix` auto-creates missing ones. |

### `--tenant=<id>` flag

Every per-model command accepts `--tenant=<id>` to run under a `TenantContext`. The command resolves the model's tenant-scoped index (when `tenantScope` is configured) before issuing the operation:

```bash
bunny search:create-index Post --tenant=42
bunny search:import Post --tenant=42 --chunk=1000
bunny search:flush Post --tenant=42
bunny search:reimport Post --tenant=42
bunny search:delete-index Post --tenant=42 --force
bunny search:sync-index-settings Post --tenant=42
bunny search:fts:optimize Post --tenant=42
bunny search:fts:rebuild Post --tenant=42
```

Without `--tenant`, commands operate in the landlord context.

### `search:verify`

Walks every searchable model and confirms its resolved index exists on the engine. Useful in CI, deploy hooks, or after onboarding a new tenant.

```bash
bunny search:verify                                    # default context
bunny search:verify --tenant=42                        # one tenant
bunny search:verify --all-tenants --include-landlord   # full sweep
bunny search:verify --all-tenants --fix                # auto-create missing
```

Output:

```
▶ tenant=42
  ✓ Post                     → posts_t_42
  ✗ Article                  → articles_t_42  (MISSING)
▶ tenant=43
  ✓ Post                     → posts_t_43
  ✓ Article                  → articles_t_43

Missing: 1. Re-run with --fix to create.
```

Exit code:
- `0` when all indexes present
- `1` when any index missing (without `--fix`) or any engine error

`--fix` re-uses each model's `searchFtsConfig` + engine `createIndex()` to provision missing entries. Safe to re-run; existing indexes are skipped.

Requires `engine.indexExists?()` — implemented by `MeilisearchEngine` (via `GET /indexes/{name}`, 404 → false) and `SqliteFTS5Engine` (via `sqlite_master` lookup filtered to FTS5 virtual tables). Engines without it skip with a warning.

`<Model>` matches the exported class name discovered in `config.modelsPath`.

## Queued sync

Set `search.queue` to push observer-triggered updates onto the existing queue subsystem:

```ts
search: {
  engine: new MeilisearchEngine({ host: "http://127.0.0.1:7700" }),
  queue: { name: "search" },
}
```

Then run a worker that picks up `MakeSearchableJob` / `RemoveFromSearchJob`:

```bash
bunny queue --queue=search
```

### Routing to a dedicated queue driver

Register a secondary driver under a name, then point `search.queue.connection` at it. Search jobs land on that driver instead of the default:

```ts
import { Queue, RedisQueueDriver } from "@bunnykit/orm/queue";

Queue.registerDriver("search-driver", new RedisQueueDriver({ /* ... */ }));

configureBunny({
  // ...
  search: {
    engine: new MeilisearchEngine({ host: "http://127.0.0.1:7700" }),
    queue: { name: "search", connection: "search-driver" },
  },
});
```

Worker process for that driver runs against the same Redis (or whatever the secondary points at). Each driver still needs its own worker process.

## Multi-tenancy

Set `tenantScope` to derive a per-tenant index name from the active `TenantContext`. The hook fires every time `Model.searchableAs()` resolves — so observer writes, queue payloads, `SearchBuilder` reads, and CLI commands all stay aligned.

```ts
configureBunny({
  // ...
  tenancy: { resolveTenant: yourResolver },
  search: {
    engine: new MeilisearchEngine({ host: "..." }),
    tenantScope: (base, tenantId) => tenantId ? `${base}_t_${tenantId}` : base,
  },
});
```

```ts
await TenantContext.run("42", async () => {
  await Post.create({ title: "..." });   // indexed in "posts_t_42"
  await Post.search("rust").get();        // reads from "posts_t_42"
});

await Post.create({ title: "..." });      // landlord → "posts"
```

**How it composes with queue mode:** `SearchObserver` resolves the index name at dispatch time, baking it into `SearchableRecord.index`. The queue worker re-enters `TenantContext.run(payload.tenantId, ...)` before calling `engine.update()`, so per-tenant connection routing (schema, RLS) is preserved end-to-end.

**Resolve outside model context:**

```ts
Search.indexFor("posts", "42");        // "posts_t_42"
Search.indexFor("posts");              // reads active TenantContext
Search.indexFor("posts", null);        // landlord

// Batch
Search.indexesFor("posts", ["1", "2", null]);
// { "1": "posts_t_1", "2": "posts_t_2", "__landlord__": "posts" }

// All tenants from configured lister
await Search.indexesForAllTenants("posts", { includeLandlord: true });
```

Wire `listTenants` either on the search config or inherit it from `tenancy.listTenants`:

```ts
configureBunny({
  tenancy: { resolveTenant, listTenants: () => listTenantIds() },
  search: {
    engine,
    tenantScope: (b, tid) => tid ? `${b}_t_${tid}` : b,
    // `listTenants` inherits from tenancy.listTenants when omitted here
  },
});
```

**CLI introspection:**

```bash
bunny search:list-indexes                            # base names
bunny search:list-indexes --tenant=42                # one tenant
bunny search:list-indexes --tenants=1,2,3            # comma list
bunny search:list-indexes --all-tenants              # uses listTenants()
bunny search:list-indexes --all-tenants --include-landlord
```

Output:

```
Post
  tenant=1             → posts_t_1
  tenant=2             → posts_t_2
  (landlord)           → posts
```

Other shipped commands (`search:create-index`, `search:import`, etc.) operate on whatever tenant context the calling process is in.

## Batch coalescing

For high-write workloads where queue mode is overkill, opt-in to in-process batching. The buffer dedupes by `${index}:${id}` so a record updated 3× in one window collapses to one HTTP push:

```ts
search: {
  engine: new MeilisearchEngine({ host: "http://127.0.0.1:7700" }),
  batch: { maxItems: 100, maxMs: 500 },
}
```

Flush triggers:
- buffer reaches `maxItems` records
- `maxMs` elapses since first buffered record
- `Search.flushPending()` called manually
- process `beforeExit` (auto-installed)

Batching is **ignored** when `search.queue` is configured — the queue handles throughput.

## Hit + page shapes

```ts
interface SearchHit {
  id: string | number;
  data: Record<string, unknown>;
  score?: number;                                        // .withScore()
  formatted?: Record<string, unknown>;                   // .highlight() / .crop()
  matchesPosition?: Record<string, MatchPosition[]>;
}

interface SearchPaginatorResult<T> {
  data: Collection<T>;
  total: number;
  page: number;
  perPage: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

interface SearchFetchResult<T> {
  data: Collection<T>;
  total: number;
  facetDistribution?: Record<string, Record<string, number>>;
}

interface SearchMultiResult {
  index: string;
  hits: SearchHit[];
  total?: number;
  facetDistribution?: Record<string, Record<string, number>>;
}
```

## Architecture

- `SearchEngine` — driver interface (`update`, `delete`, `search`, `paginate`, `multiSearch?`, `flush`, `createIndex`, `deleteIndex`, `updateIndexSettings`, `health?`).
- `MeilisearchEngine` — HTTP driver. Filters compile to Meili expressions (`field = "v"`, `field IN [..]`); sorts to `field:dir`; facets/highlight/crop/min-score/attributesToSearchOn passed through.
- `Searchable(Base)` — mixin adding the static API and a per-instance `searchable()` / `unsearchable()` pair.
- `SearchObserver` — internal `ObserverContract` impl attached via `Search.register(Model)`. Fires on `saved`/`deleted`.
- `SearchBuilder` — fluent query builder; returns hydrated ORM models.
- `MakeSearchableJob` / `RemoveFromSearchJob` — queue jobs for async sync.
- `Search.multi(builders)` — single round-trip across multiple indexes; routes through `engine.multiSearch()` when available, falls back to sequential `engine.search()`.

## Engine: `SqliteFTS5Engine`

For apps where you don't want to run a separate Meilisearch service, SQLite's built-in FTS5 full-text engine works as a drop-in `SearchEngine`. Same interface, same builder API, all filters/facets/score/highlight (where SQLite has equivalents).

### Setup — same DB as the app (recommended for SQLite apps)

Declare the FTS5 schema on the model. `search:create-index` discovers it automatically.

```ts
// app/models/Post.ts
import { Model } from "@bunnykit/orm";
import { Search } from "@bunnykit/orm/search";

class _Post extends Model.define<PostAttributes>("posts") {
  static fillable = ["title", "body", "status"];
}

export const Post = Search.register(_Post, {
  index: "posts_fts",
  fts: {
    columns: ["title", "body"],          // tokenized
    unindexed: ["status", "author_id"],  // stored for filters
    tokenizer: "porter unicode61",       // optional
  },
  toSearchableArray: (m) => ({
    title: m.getAttribute("title"),
    body: m.getAttribute("body"),
    status: m.getAttribute("status"),
  }),
});

export type PostInstance = InstanceType<typeof Post>;
export default Post;
```

```ts
// app.ts
import { configureBunny } from "@bunnykit/orm";
import { SqliteFTS5Engine } from "@bunnykit/orm/search";

configureBunny({
  connection: { url: "sqlite://./app.db" },
  modelsPath: "./app/models",
  search: { engine: new SqliteFTS5Engine({ shared: true }) },
});
```

```bash
bunny search:create-index Post   # picks up Post.searchFtsConfig automatically
```

`shared: true` reuses the ORM's default connection — index lives in the same SQLite file as app data. Backups cover both. One file.

### Setup — separate SQLite index file (Postgres/MySQL app)

```ts
import { Connection } from "@bunnykit/orm";

const searchConn = new Connection({ url: "sqlite://./search.db" });
const fts = new SqliteFTS5Engine({ connection: searchConn });
fts.configureIndex("posts_fts", { columns: ["title", "body"], unindexed: ["status"] });

configureBunny({
  connection: { url: "postgres://app:pw@host/db" },
  search: { engine: fts },
});
await fts.createIndex("posts_fts");
```

App data stays in Postgres; the search index lives in a single SQLite file. Sync via the same `SearchObserver` flow as Meilisearch.

### Trigger mode — instant in-transaction sync (same-DB only)

When app data and FTS5 table share the same SQLite file, you can let SQLite handle sync via AFTER INSERT/UPDATE/DELETE triggers. The observer self-disables — every write (including raw SQL) updates the index inside the same transaction.

```ts
const fts = new SqliteFTS5Engine({ shared: true, useTriggers: true });
fts.configureIndex("posts_fts", {
  columns: ["title", "body"],
  contentTable: "posts",    // required for triggers
  contentRowid: "id",       // PK column on the source table
});
await fts.createIndex("posts_fts");
```

`createIndex()` emits the FTS5 table **and** three triggers (`posts_fts_ai`, `_ad`, `_au`). `deleteIndex()` drops them.

### Capability matrix

| Builder feature | SqliteFTS5 | Meilisearch |
|---|---|---|
| `where` / `whereIn` / `whereBetween` / `whereNull` / `whereExists` / `whereRaw` | ✅ via SQL on UNINDEXED columns | ✅ |
| OR / nested groups | ✅ | ✅ |
| `orderBy` | ✅ — default is `bm25()` relevance | ✅ |
| `take` / pagination / `simplePaginate` / `cursor` | ✅ | ✅ |
| `.facet()` / facet distribution | ✅ — SQL `GROUP BY` | ✅ native |
| `.minScore()` | ✅ — `bm25()` threshold | ✅ |
| `.searchOn()` / `.boost()` | ✅ — FTS5 column-scoped match | ✅ |
| `.withScore()` | ✅ — exposes `-bm25()` | ✅ |
| `.highlight()` / `.crop()` | ⚠️ FTS5 has `highlight()` + `snippet()` but not wired in v1 | ✅ |
| `matchesPosition` | ⚠️ FTS5 `offsets()` available but not wired | ✅ |
| `Search.multi([...])` | sequential | native multi-search |

### Caveats

- **Single writer.** SQLite serializes writes. Run search sync through a queue worker (`bunny queue --queue=search`) in multi-process apps to avoid lock contention.
- **Single node.** SQLite file lives on one disk. For replicated reads, use Litestream/rqlite.
- **Schema-tied.** Columns are fixed at `createIndex()` time. Renaming a tracked column means `deleteIndex()` + `createIndex()` + `bunny search:reimport`.
- **Enable WAL.** `PRAGMA journal_mode=WAL` for concurrent readers.
- **Migrations.** When using `useTriggers`, treat the FTS table + triggers as part of your migrations so they survive `migrate:fresh`.

## Not yet in v1

- Other engines (Algolia, Typesense, FlexSearch, Postgres `tsvector`, MySQL `MATCH AGAINST`) — interface is ready, implementations are not.
- Task completion polling (Meilisearch async operations return task UIDs; v1 does not wait).
- Highlight / snippet / matches-position passthrough for SqliteFTS5Engine.
- Multi-tenant index routing.
