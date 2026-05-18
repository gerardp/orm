import { expect, test, describe } from "bun:test";
import { Builder, Cache, MemoryCacheStore, Model, Observer, ObserverRegistry, RedisCacheStore, Schema, configureBunny } from "../src/index.js";
import type { CacheRememberOptions, CacheStore } from "../src/index.js";
import { setupTestDb } from "./helpers.js";

class FakeRedis {
  values = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  calls: any[][] = [];

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...options: any[]): Promise<"OK"> {
    this.calls.push(["set", key, value, ...options]);
    this.values.set(key, value);
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.calls.push(["del", ...keys]);
    let count = 0;
    for (const key of keys) {
      if (this.values.delete(key)) count++;
      if (this.sets.delete(key)) count++;
    }
    return count;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    this.calls.push(["sadd", key, ...members]);
    let set = this.sets.get(key);
    if (!set) {
      set = new Set<string>();
      this.sets.set(key, set);
    }
    const before = set.size;
    for (const member of members) set.add(member);
    return set.size - before;
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async scan(_cursor: string | number, _match: "MATCH", pattern: string): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, "");
    return ["0", [...this.values.keys(), ...this.sets.keys()].filter((key) => key.startsWith(prefix))];
  }
}

class CustomCacheStore implements CacheStore {
  values = new Map<string, unknown>();
  tags = new Map<string, Set<string>>();

  async get<T = unknown>(key: string): Promise<T | null> {
    return this.values.has(key) ? this.values.get(key) as T : null;
  }

  async set<T = unknown>(key: string, value: T, options: CacheRememberOptions = {}): Promise<void> {
    this.values.set(key, value);
    for (const tag of options.tags ?? []) {
      let keys = this.tags.get(tag);
      if (!keys) {
        keys = new Set<string>();
        this.tags.set(tag, keys);
      }
      keys.add(key);
    }
  }

  async forget(key: string): Promise<void> {
    this.values.delete(key);
  }

  async forgetTag(tag: string): Promise<void> {
    for (const key of this.tags.get(tag) ?? []) {
      this.values.delete(key);
    }
    this.tags.delete(tag);
  }

  async forgetTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.forgetTag(tag);
    }
  }

  async flush(): Promise<void> {
    this.values.clear();
    this.tags.clear();
  }
}

async function exerciseStore(store: CacheStore) {
  await store.set("a", { id: 1 }, { tags: ["group:a"] });
  await store.set("b", { id: 2 }, { tags: ["group:a", "group:b"] });
  expect(await store.get("a")).toEqual({ id: 1 });

  await store.forget("a");
  expect(await store.get("a")).toBeNull();
  expect(await store.get("b")).toEqual({ id: 2 });

  await store.forgetTag("group:a");
  expect(await store.get("b")).toBeNull();

  await store.set("c", { id: 3 }, { tags: ["group:c"] });
  await store.set("d", { id: 4 }, { tags: ["group:d"] });
  await store.forgetTags(["group:c", "group:d"]);
  expect(await store.get("c")).toBeNull();
  expect(await store.get("d")).toBeNull();

  await store.set("e", { id: 5 });
  await store.flush();
  expect(await store.get("e")).toBeNull();
}

describe("Cache stores", () => {
  test("MemoryCacheStore mirrors tag invalidation and flush behavior", async () => {
    await exerciseStore(new MemoryCacheStore());
  });

  test("MemoryCacheStore expires values lazily on read", async () => {
    const store = new MemoryCacheStore();
    await store.set("short", "value", { ttl: 0.001 });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.get("short")).toBeNull();
  });

  test("RedisCacheStore uses Bun Redis-compatible commands", async () => {
    const redis = new FakeRedis();
    const store = new RedisCacheStore(redis as any);

    await store.set("ttl", { ok: true }, { ttl: 60, tags: ["tagged"] });
    expect(redis.calls).toContainEqual(["set", "bunny:cache:ttl", JSON.stringify({ ok: true }), "EX", 60]);
    expect(redis.calls).toContainEqual(["sadd", "bunny:tag:tagged", "bunny:cache:ttl"]);

    await exerciseStore(store);
  });

  test("Cache facade remembers values and prefixes keys and tags", async () => {
    const store = new MemoryCacheStore();
    Cache.configure({ store, prefix: "app:", defaultTtl: 30 });
    let calls = 0;

    const first = await Cache.remember("payload", { tags: ["payloads"] }, async () => {
      calls++;
      return { value: 1 };
    });
    const second = await Cache.remember("payload", { tags: ["payloads"] }, async () => {
      calls++;
      return { value: 2 };
    });

    expect(first).toEqual({ value: 1 });
    expect(second).toEqual({ value: 1 });
    expect(calls).toBe(1);
    expect(await store.get("app:payload")).toEqual({ value: 1 });

    await Cache.forgetTag("payloads");
    expect(await Cache.get("payload")).toBeNull();
  });

  test("configureBunny installs Redis by default when cache config is present", () => {
    configureBunny({
      connection: { url: "sqlite://:memory:" },
      cache: {},
    });

    expect(Cache.getStore()).toBeInstanceOf(RedisCacheStore);
  });

  test("configureBunny accepts a custom cache store", async () => {
    const store = new CustomCacheStore();
    configureBunny({
      connection: { url: "sqlite://:memory:" },
      cache: { store, prefix: "tenant:" },
    });

    await Cache.set("key", "value");
    expect(await store.get("tenant:key")).toBe("value");

    await Cache.set("tagged", "value", { tags: ["lookup"] });
    await Cache.forgetTag("lookup");
    expect(await Cache.get("tagged")).toBeNull();
  });
});

class CachedWidget extends Model {
  static table = "cached_widgets";
  static timestamps = false;
}

describe("Query builder cache", () => {
  test("remember avoids duplicate DB reads and hydrates cached rows", async () => {
    const connection = setupTestDb();
    Cache.configure({ store: new MemoryCacheStore() });
    await Schema.create("cached_widgets", (table) => {
      table.increments("id");
      table.string("name");
    });
    await CachedWidget.create({ name: "Alpha" });

    let reads = 0;
    const originalQuery = connection.query.bind(connection);
    connection.query = ((sql: string, bindings?: any[]) => {
      if (sql.includes("cached_widgets")) reads++;
      return originalQuery(sql, bindings);
    }) as any;

    const first = await CachedWidget.query().remember("widgets", 60).cacheTags("widgets").get();
    const second = await CachedWidget.query().remember("widgets", 60).cacheTags("widgets").get();

    expect(reads).toBe(1);
    expect(first[0]).toBeInstanceOf(CachedWidget);
    expect(second[0]).toBeInstanceOf(CachedWidget);
    expect(second[0].name).toBe("Alpha");
  });

  test("cacheTags allows invalidation through Cache.forgetTag", async () => {
    const connection = setupTestDb();
    Cache.configure({ store: new MemoryCacheStore() });
    await connection.run("CREATE TABLE cached_tagged (id INTEGER PRIMARY KEY, name TEXT)");
    await connection.run("INSERT INTO cached_tagged (name) VALUES ('old')");

    const builder = new Builder(connection, "cached_tagged").remember("tagged", 60).cacheTags("tagged");
    expect((await builder.get())[0].name).toBe("old");
    await connection.run("UPDATE cached_tagged SET name = 'new'");
    expect((await builder.clone().get())[0].name).toBe("old");
    await Cache.forgetTag("tagged");
    expect((await builder.clone().get())[0].name).toBe("new");
  });

  test("cache is bypassed inside active transactions", async () => {
    const connection = setupTestDb();
    Cache.configure({ store: new MemoryCacheStore() });
    await connection.run("CREATE TABLE cached_transactions (id INTEGER PRIMARY KEY, name TEXT)");
    await connection.run("INSERT INTO cached_transactions (name) VALUES ('outside')");

    await new Builder(connection, "cached_transactions").remember("trx", 60).get();

    await connection.transaction(async (tx) => {
      await tx.run("UPDATE cached_transactions SET name = 'inside'");
      const rows = await new Builder(tx, "cached_transactions").remember("trx", 60).get();
      expect(rows[0].name).toBe("inside");
    });
  });

  test("clone preserves cache options", async () => {
    const connection = setupTestDb();
    Cache.configure({ store: new MemoryCacheStore() });
    await connection.run("CREATE TABLE cached_clones (id INTEGER PRIMARY KEY, name TEXT)");
    await connection.run("INSERT INTO cached_clones (name) VALUES ('first')");

    const builder = new Builder(connection, "cached_clones").remember("clone", 60).cacheTags("clone");
    expect((await builder.clone().get())[0].name).toBe("first");
    await connection.run("UPDATE cached_clones SET name = 'second'");
    expect((await builder.clone().get())[0].name).toBe("first");
    await Cache.forgetTag("clone");
    expect((await builder.clone().get())[0].name).toBe("second");
  });
});

class ObservedCachedWidget extends Model {
  static table = "observed_cached_widgets";
  static timestamps = false;
}

describe("Observer cache invalidation", () => {
  test("observer can invalidate exact cache tags", async () => {
    const connection = setupTestDb();
    Cache.configure({ store: new MemoryCacheStore() });
    await Schema.create("observed_cached_widgets", (table) => {
      table.increments("id");
      table.string("name");
    });
    await ObservedCachedWidget.create({ name: "old" });

    class ObservedCachedWidgetObserver extends Observer<ObservedCachedWidget> {
      saved() {
        return Cache.forgetTag("observed");
      }
    }

    ObservedCachedWidgetObserver.observe(ObservedCachedWidget);

    const builder = ObservedCachedWidget.query().remember("observed", 60).cacheTags("observed");
    expect((await builder.get())[0].name).toBe("old");

    const widget = await ObservedCachedWidget.query().firstOrFail();
    widget.name = "new";
    await widget.save();

    expect((await builder.clone().get())[0].name).toBe("new");
    ObserverRegistry.unregister(ObservedCachedWidget);
  });
});
