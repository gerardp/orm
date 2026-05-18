# Cache

Bunny includes an explicit, opt-in cache layer for application payloads and selected query results. It supports exact tag invalidation, which is useful for reference data such as curricula, subjects, grade levels, terms, admissions lookup payloads, and other shared read-heavy data.

The cache API can be used with or without the ORM:

```ts
import { Cache, MemoryCacheStore, RedisCacheStore } from "@bunnykit/orm/cache";
```

## Setup

### Runtime configuration

When you configure Bunny at application startup, add a `cache` block:

```ts
import { configureBunny } from "@bunnykit/orm";

configureBunny({
  connection: { url: process.env.DATABASE_URL! },
  cache: {
    prefix: "app:",
    defaultTtl: 3600,
  },
});
```

If `cache.store` is omitted, Bunny uses Bun's native Redis client:

```ts
import { redis } from "bun";
import { RedisCacheStore } from "@bunnykit/orm/cache";

cache: {
  store: new RedisCacheStore(redis),
}
```

Bun's default Redis client reads `REDIS_URL` from the environment. If it is not set, Bun uses its own Redis default.

### Standalone configuration

Use `Cache.configure()` when you want the cache outside a configured ORM application, such as a worker or small utility module:

```ts
import { Cache, RedisCacheStore } from "@bunnykit/orm/cache";
import { redis } from "bun";

Cache.configure({
  store: new RedisCacheStore(redis),
  prefix: "app:",
  defaultTtl: 3600,
});
```

For tests and local non-Redis usage, use the memory store:

```ts
import { Cache, MemoryCacheStore } from "@bunnykit/orm/cache";

Cache.configure({
  store: new MemoryCacheStore(),
});
```

`MemoryCacheStore` is process-local. It is not a shared production cache.

### Custom stores

You can plug in any cache backend by implementing `CacheStore`:

```ts
import type { CacheRememberOptions, CacheStore } from "@bunnykit/orm/cache";

class MyCacheStore implements CacheStore {
  async get<T = unknown>(key: string): Promise<T | null> {
    // Return null on cache miss.
    return null;
  }

  async set<T = unknown>(
    key: string,
    value: T,
    options: CacheRememberOptions = {},
  ): Promise<void> {
    // Store value, apply options.ttl when provided, and associate options.tags.
  }

  async forget(key: string): Promise<void> {
    // Remove one cached value.
  }

  async forgetTag(tag: string): Promise<void> {
    // Remove every cached value associated with this exact tag.
  }

  async forgetTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.forgetTag(tag);
    }
  }

  async flush(): Promise<void> {
    // Clear this store's cache namespace.
  }
}
```

Then pass the store to `configureBunny()`:

```ts
import { configureBunny } from "@bunnykit/orm";
import { MyCacheStore } from "./MyCacheStore";

configureBunny({
  connection: { url: process.env.DATABASE_URL! },
  cache: {
    store: new MyCacheStore(),
    prefix: "app:",
    defaultTtl: 3600,
  },
});
```

Or configure it directly for standalone usage:

```ts
import { Cache } from "@bunnykit/orm/cache";
import { MyCacheStore } from "./MyCacheStore";

Cache.configure({
  store: new MyCacheStore(),
});
```

Custom stores receive keys and tags after the facade prefix has been applied. Store implementations are responsible for their own serialization, TTL behavior, tag index, and namespace-aware `flush()` behavior.

## Application Cache

Use `Cache.remember()` for composed payloads where one cached value depends on several tables or models:

```ts
import { Cache } from "@bunnykit/orm/cache";

const countries = await Cache.remember("countries", async () => {
  return buildCountryList();
});

await Cache.remember("hello", "world", 3600);

const payload = await Cache.remember(
  `tenant:${tenantId}:admissions-reference`,
  async () => buildAdmissionsReferencePayload(),
  {
    ttl: 3600,
    tags: `tenant:${tenantId}:admissions-reference`,
  },
);
```

If the value is already cached, a resolver callback is not called and a direct value is not written. If there is a miss, Bunny stores the returned or provided value as JSON.

You can also use lower-level operations:

```ts
await Cache.set("countries", [{ code: "PH", name: "Philippines" }], {
  ttl: 86400,
  tags: ["countries"],
});

const countries = await Cache.get("countries");

await Cache.forget("countries");
await Cache.flush();
```

## Tagged Invalidation

Tags are exact strings. Bunny does not perform wildcard or prefix tag matching.

```ts
await Cache.forgetTag(`tenant:${tenantId}:subjects`);

await Cache.forgetTags([
  `tenant:${tenantId}:curricula`,
  `tenant:${tenantId}:subjects`,
  `tenant:${tenantId}:admissions-reference`,
]);

await Cache.forgetTags(
  `tenant:${tenantId}:curricula`,
  `tenant:${tenantId}:subjects`,
  `tenant:${tenantId}:admissions-reference`,
);
```

Recommended tenant-scoped tags:

```ts
`tenant:${tenantId}:curricula`
`tenant:${tenantId}:subjects`
`tenant:${tenantId}:curriculum-subjects`
`tenant:${tenantId}:academic-structure`
`tenant:${tenantId}:admissions-reference`
```

Use observers to invalidate exact tags when models change:

```ts
import { Cache, Observer } from "@bunnykit/orm";

class CurriculumObserver extends Observer<Curriculum> {
  saved(model: Curriculum) {
    return this.invalidate(model);
  }

  deleted(model: Curriculum) {
    return this.invalidate(model);
  }

  private invalidate(model: Curriculum) {
    return Cache.forgetTags([
      `tenant:${model.tenant_id}:curricula`,
      `tenant:${model.tenant_id}:curriculum-subjects`,
      `tenant:${model.tenant_id}:admissions-reference`,
    ]);
  }
}

CurriculumObserver.observe(Curriculum);
```

## Query Caching

Query caching is always explicit. Bunny only caches a query when you call `remember()`.

For reusable read paths, a static helper on the model is the cleanest pattern:

```ts
class Admission extends Model {
  static cacheAdmissions() {
    return this.query()
      .with(["student", "program"])
      .remember("admissions_with_student_and_program")
      .cacheTags("admissions_with_student_and_program", "admissions");
  }
}

const admissions = await Admission.cacheAdmissions().get();
```

This keeps the cache key, eager loads, and invalidation tags in one place without inventing a separate caching abstraction.

```ts
const curricula = await Curriculum
  .where("active", true)
  .remember(`tenant:${tenantId}:curricula`, 3600)
  .cacheTags(`tenant:${tenantId}:curricula`)
  .get();
```

Cached query rows are stored before model hydration. On cache hits, Bunny hydrates models normally, so casts, accessors, collections, and model instances behave the same as a database-backed read.

When the cached builder includes eager loads, Bunny caches the full hydrated model graph:

```ts
const periods = await EnrollmentPeriod
  .with(["academicYear", "semesters"])
  .orderBy("start_date", "desc")
  .remember("admission_periods")
  .cacheTags("admission_periods")
  .get();
```

The first read queries `enrollment_periods` and the eager-loaded relations. Later reads for the same cache key rehydrate the parent models and their loaded relations from cache. After `Cache.forgetTag("admission_periods")`, the next read queries and refreshes the whole graph.

Use multiple tags when a query result depends on more than one concept:

```ts
const subjects = await Subject
  .where("active", true)
  .remember(`tenant:${tenantId}:active-subjects`, 3600)
  .cacheTags(
    `tenant:${tenantId}:subjects`,
    `tenant:${tenantId}:academic-structure`,
  )
  .get();
```

## Safety Rules

Bunny intentionally keeps query caching narrow:

- Queries are cached only after an explicit `remember(key, ttl?)`.
- Cache keys are application-defined.
- Cache is bypassed inside active transactions.
- Locked queries are not cached.
- Random-order queries are not cached.
- Internal `chunk`, `chunkById`, `cursor`, `each`, and `lazy` iteration queries do not reuse one cache key across pages.
- Mutations and raw writes are not cached.

For composed responses that include several models or eager-loaded datasets, prefer `Cache.remember()` around the full payload builder.

## Prefixes

`Cache.configure({ prefix })` prefixes keys and tags at the facade level:

```ts
Cache.configure({
  store: new MemoryCacheStore(),
  prefix: "school:",
});

await Cache.set("subjects", [], { tags: ["subjects"] });
// Stored as key "school:subjects" and tag "school:subjects".
```

`RedisCacheStore` also has its own namespace prefix for Redis keys. By default it writes values and tag sets under a `bunny:` namespace:

```ts
new RedisCacheStore(redis, { prefix: "bunny:" });
```

In most applications, use the facade prefix for app or tenant namespacing and leave the Redis store prefix as the package namespace.
