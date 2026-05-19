import { describe, it, expect, beforeEach } from "bun:test";
import { RedisQueueDriver } from "../src/queue/RedisQueueDriver.js";

// In-memory Redis mock — enough to exercise the driver without a live server
function makeRedis() {
  const strings = new Map<string, string>();
  const hashes = new Map<string, Map<string, string>>();
  const lists = new Map<string, string[]>();
  const zsets = new Map<string, Map<string, number>>(); // member → score
  const sets = new Map<string, Set<string>>();

  return {
    async incr(key: string): Promise<number> {
      const v = parseInt(strings.get(key) ?? "0", 10) + 1;
      strings.set(key, String(v));
      return v;
    },
    async rpush(key: string, ...values: string[]): Promise<number> {
      const list = lists.get(key) ?? [];
      list.push(...values);
      lists.set(key, list);
      return list.length;
    },
    async lpush(key: string, ...values: string[]): Promise<number> {
      const list = lists.get(key) ?? [];
      list.unshift(...values);
      lists.set(key, list);
      return list.length;
    },
    async lpop(key: string): Promise<string | null> {
      const list = lists.get(key);
      if (!list || list.length === 0) return null;
      return list.shift() ?? null;
    },
    async llen(key: string): Promise<number> {
      return lists.get(key)?.length ?? 0;
    },
    async hset(key: string, fields: Record<string, string | number>): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>();
      let added = 0;
      for (const [f, v] of Object.entries(fields)) {
        if (!hash.has(f)) added++;
        hash.set(f, String(v));
      }
      hashes.set(key, hash);
      return added;
    },
    async hgetall(key: string): Promise<Record<string, string>> {
      const hash = hashes.get(key);
      if (!hash) return {} as any;
      return Object.fromEntries(hash.entries());
    },
    async hincrby(key: string, field: string, increment: number): Promise<number> {
      const hash = hashes.get(key) ?? new Map<string, string>();
      const cur = parseInt(hash.get(field) ?? "0", 10) + increment;
      hash.set(field, String(cur));
      hashes.set(key, hash);
      return cur;
    },
    async del(...keys: string[]): Promise<number> {
      let n = 0;
      for (const k of keys) {
        if (strings.delete(k) || hashes.delete(k) || lists.delete(k) || zsets.delete(k) || sets.delete(k)) n++;
      }
      return n;
    },
    async zadd(key: string, ...args: (string | number)[]): Promise<number> {
      const zset = zsets.get(key) ?? new Map<string, number>();
      let added = 0;
      for (let i = 0; i < args.length; i += 2) {
        const score = Number(args[i]);
        const member = String(args[i + 1]);
        if (!zset.has(member)) added++;
        zset.set(member, score);
      }
      zsets.set(key, zset);
      return added;
    },
    async zrem(key: string, ...members: string[]): Promise<number> {
      const zset = zsets.get(key);
      if (!zset) return 0;
      let n = 0;
      for (const m of members) { if (zset.delete(m)) n++; }
      return n;
    },
    async zrangebyscore(key: string, min: number, max: number): Promise<string[]> {
      const zset = zsets.get(key);
      if (!zset) return [];
      return [...zset.entries()]
        .filter(([, score]) => score >= min && score <= max)
        .sort(([, a], [, b]) => a - b)
        .map(([member]) => member);
    },
    async zcard(key: string): Promise<number> {
      return zsets.get(key)?.size ?? 0;
    },
    async sadd(key: string, ...members: string[]): Promise<number> {
      const set = sets.get(key) ?? new Set<string>();
      let added = 0;
      for (const m of members) { if (!set.has(m)) { set.add(m); added++; } }
      sets.set(key, set);
      return added;
    },
    async smembers(key: string): Promise<string[]> {
      return [...(sets.get(key) ?? new Set())];
    },
    // expose internals for test inspection
    _lists: lists,
    _zsets: zsets,
    _hashes: hashes,
  };
}

describe("RedisQueueDriver", () => {
  let redis: ReturnType<typeof makeRedis>;
  let driver: RedisQueueDriver;

  beforeEach(() => {
    redis = makeRedis();
    driver = new RedisQueueDriver(redis as any, { prefix: "test:" });
  });

  it("migrate() is a no-op", async () => {
    await expect(driver.migrate()).resolves.toBeUndefined();
  });

  it("dispatches and reserves a job", async () => {
    await driver.dispatch("default", "SendEmail", JSON.stringify({ args: ["a@b.com"] }), 0, 3);
    const job = await driver.reserve("default", 90);
    expect(job).not.toBeNull();
    expect(job!.jobClass).toBe("SendEmail");
    expect(job!.attempts).toBe(1);
    expect(job!.queue).toBe("default");
    expect(JSON.parse(job!.payload).args).toEqual(["a@b.com"]);
  });

  it("returns null when queue empty", async () => {
    expect(await driver.reserve("default", 90)).toBeNull();
  });

  it("does not reserve same job twice", async () => {
    await driver.dispatch("default", "A", "{}", 0, 3);
    const j1 = await driver.reserve("default", 90);
    const j2 = await driver.reserve("default", 90);
    expect(j1).not.toBeNull();
    expect(j2).toBeNull();
  });

  it("complete() removes job data", async () => {
    await driver.dispatch("default", "A", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.complete(job!.id);
    expect(await driver.size("default")).toBe(0);
    // hash should be gone
    const fields = await redis.hgetall(`test:job:${job!.id}`);
    expect(Object.keys(fields)).toHaveLength(0);
  });

  it("fail() writes to failed list and removes job", async () => {
    await driver.dispatch("default", "BadJob", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.fail(job!.id, "Error: exploded");

    const failedKey = "test:failed";
    const list = redis._lists.get(failedKey);
    expect(list).toHaveLength(1);
    const record = JSON.parse(list![0]);
    expect(record.jobClass).toBe("BadJob");
    expect(record.exception).toContain("exploded");
    expect(await driver.size("default")).toBe(0);
  });

  it("release() with no delay puts job back at front", async () => {
    await driver.dispatch("default", "RetryMe", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.release(job!.id, 0);

    const list = redis._lists.get("test:pending:default");
    expect(list).toHaveLength(1);
    expect(list![0]).toBe(String(job!.id));
  });

  it("release() with delay goes to delayed set", async () => {
    await driver.dispatch("default", "RetryMe", "{}", 0, 3);
    const job = await driver.reserve("default", 90);
    await driver.release(job!.id, 60);

    expect(await driver.size("default")).toBe(1); // counts delayed
    const next = await driver.reserve("default", 90);
    expect(next).toBeNull(); // not available yet
  });

  it("dispatch() with delay goes to delayed set, not pending", async () => {
    await driver.dispatch("default", "LazyJob", "{}", 60, 3);
    expect(await driver.size("default")).toBe(1); // in delayed
    const job = await driver.reserve("default", 90);
    expect(job).toBeNull();
  });

  it("delayed jobs migrate to pending when available_at passes", async () => {
    const now = Math.floor(Date.now() / 1000);
    await driver.dispatch("default", "ReadyJob", "{}", 0, 3);
    // manually backdate available_at to simulate a delayed job that is now due
    const id = 1;
    const past = now - 10;
    await redis.zadd("test:delayed:default", past, String(id));
    // also put it in the hash so hgetall returns data
    await redis.hset(`test:job:${id}`, {
      queue: "default", jobClass: "ReadyJob", payload: "{}", attempts: 0, maxAttempts: 3,
      availableAt: past, createdAt: past,
    });

    // Pop the real pending entry first (from the non-delayed dispatch)
    await driver.reserve("default", 90);

    // Now only the "delayed" job should be migrated and become reservable
    // Reset the delayed set to only have our backdated entry
    redis._zsets.set("test:delayed:default", new Map([[String(id), past]]));
    redis._lists.set("test:pending:default", []);

    const job = await driver.reserve("default", 90);
    expect(job).not.toBeNull();
    expect(job!.jobClass).toBe("ReadyJob");
  });

  it("timed-out reserved jobs get re-queued", async () => {
    await driver.dispatch("default", "StuckJob", "{}", 0, 3);
    const job = await driver.reserve("default", 90);

    // Manually expire the reservation
    const old = Math.floor(Date.now() / 1000) - 200;
    redis._zsets.get("test:reserved:default")!.set(String(job!.id), old);

    const reReserved = await driver.reserve("default", 90);
    expect(reReserved).not.toBeNull();
    expect(reReserved!.id).toBe(job!.id);
  });

  it("respects named queues", async () => {
    await driver.dispatch("emails", "SendEmail", "{}", 0, 3);
    await driver.dispatch("reports", "GenReport", "{}", 0, 3);
    expect((await driver.reserve("emails", 90))?.jobClass).toBe("SendEmail");
    expect((await driver.reserve("reports", 90))?.jobClass).toBe("GenReport");
  });

  it("size() counts pending + delayed", async () => {
    await driver.dispatch("default", "A", "{}", 0, 3);
    await driver.dispatch("default", "B", "{}", 60, 3);
    expect(await driver.size("default")).toBe(2);
  });

  it("size() without queue sums all queues", async () => {
    await driver.dispatch("a", "A", "{}", 0, 3);
    await driver.dispatch("b", "B", "{}", 0, 3);
    expect(await driver.size()).toBe(2);
  });

  it("stores custom maxAttempts", async () => {
    await driver.dispatch("default", "FragileJob", "{}", 0, 1);
    const job = await driver.reserve("default", 90);
    expect(job!.maxAttempts).toBe(1);
  });

  it("tracks queue names in queues set", async () => {
    await driver.dispatch("critical", "A", "{}", 0, 3);
    const queues = await redis.smembers("test:queues");
    expect(queues).toContain("critical");
  });
});
