import type { RedisClient } from "bun";
import type { JobRecord, QueueDriver } from "./QueueDriver.js";

type RedisQueueLike = Pick<
  RedisClient,
  | "incr"
  | "rpush"
  | "lpush"
  | "lpop"
  | "llen"
  | "hset"
  | "hgetall"
  | "hincrby"
  | "del"
  | "zadd"
  | "zrem"
  | "zrangebyscore"
  | "zcard"
  | "sadd"
  | "smembers"
>;

export interface RedisQueueDriverOptions {
  prefix?: string;
}

interface StoredJob {
  queue: string;
  jobClass: string;
  payload: string;
  attempts: string;
  maxAttempts: string;
  availableAt: string;
  createdAt: string;
}

export class RedisQueueDriver implements QueueDriver {
  private prefix: string;

  constructor(private client: RedisQueueLike, options: RedisQueueDriverOptions = {}) {
    this.prefix = options.prefix ?? "bunny:queue:";
  }

  // No DDL needed for Redis
  async migrate(): Promise<void> {}

  async dispatch(queue: string, jobClass: string, payload: string, delaySeconds: number, maxAttempts: number): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const availableAt = now + delaySeconds;
    const id = await this.client.incr(this.key("id"));

    await this.client.hset(this.jobKey(id), {
      queue,
      jobClass,
      payload,
      attempts: 0,
      maxAttempts,
      availableAt,
      createdAt: now,
    });

    await this.client.sadd(this.key("queues"), queue);

    if (delaySeconds > 0) {
      await this.client.zadd(this.delayedKey(queue), availableAt, String(id));
    } else {
      await this.client.rpush(this.pendingKey(queue), String(id));
    }
  }

  async reserve(queue: string, retryAfterSeconds: number): Promise<JobRecord | null> {
    const now = Math.floor(Date.now() / 1000);

    await this.migrateDelayed(queue, now);
    await this.requeueTimedOut(queue, now, retryAfterSeconds);

    const popped = await this.client.lpop(this.pendingKey(queue));
    if (!popped) return null;

    const id = parseInt(popped, 10);
    const fields = (await this.client.hgetall(this.jobKey(id))) as unknown as StoredJob | undefined;

    if (!fields?.jobClass) {
      // Job data missing (evicted or manually deleted) — skip silently
      return null;
    }

    const attempts = await this.client.hincrby(this.jobKey(id), "attempts", 1);
    await this.client.zadd(this.reservedKey(queue), now, String(id));

    return this.toJobRecord(id, fields, attempts);
  }

  async complete(id: number): Promise<void> {
    const fields = (await this.client.hgetall(this.jobKey(id))) as unknown as StoredJob | undefined;
    if (fields?.queue) {
      await this.client.zrem(this.reservedKey(fields.queue), String(id));
    }
    await this.client.del(this.jobKey(id));
  }

  async fail(id: number, exception: string): Promise<void> {
    const fields = (await this.client.hgetall(this.jobKey(id))) as unknown as StoredJob | undefined;
    if (!fields?.jobClass) return;

    const record = JSON.stringify({
      queue: fields.queue,
      jobClass: fields.jobClass,
      payload: fields.payload,
      exception,
      failedAt: Math.floor(Date.now() / 1000),
    });

    await this.client.rpush(this.key("failed"), record);
    await this.client.zrem(this.reservedKey(fields.queue), String(id));
    await this.client.del(this.jobKey(id));
  }

  async release(id: number, delaySeconds: number): Promise<void> {
    const fields = (await this.client.hgetall(this.jobKey(id))) as unknown as StoredJob | undefined;
    if (!fields?.queue) return;

    const now = Math.floor(Date.now() / 1000);
    const availableAt = now + delaySeconds;

    await this.client.zrem(this.reservedKey(fields.queue), String(id));
    await this.client.hset(this.jobKey(id), { availableAt });

    if (delaySeconds > 0) {
      await this.client.zadd(this.delayedKey(fields.queue), availableAt, String(id));
    } else {
      await this.client.lpush(this.pendingKey(fields.queue), String(id));
    }
  }

  async size(queue?: string): Promise<number> {
    if (queue) {
      return this.queueSize(queue);
    }

    const queues = await this.client.smembers(this.key("queues"));
    let total = 0;
    for (const q of queues) {
      total += await this.queueSize(q);
    }
    return total;
  }

  private async queueSize(queue: string): Promise<number> {
    const pending = await this.client.llen(this.pendingKey(queue));
    const delayed = await this.client.zcard(this.delayedKey(queue));
    return pending + delayed;
  }

  private async migrateDelayed(queue: string, now: number): Promise<void> {
    const ids = await this.client.zrangebyscore(this.delayedKey(queue), 0, now);
    for (const id of ids) {
      await this.client.zrem(this.delayedKey(queue), id);
      await this.client.rpush(this.pendingKey(queue), id);
    }
  }

  private async requeueTimedOut(queue: string, now: number, retryAfterSeconds: number): Promise<void> {
    const cutoff = now - retryAfterSeconds;
    const ids = await this.client.zrangebyscore(this.reservedKey(queue), 0, cutoff);
    for (const id of ids) {
      await this.client.zrem(this.reservedKey(queue), id);
      await this.client.lpush(this.pendingKey(queue), id);
    }
  }

  private toJobRecord(id: number, fields: StoredJob, attempts: number): JobRecord {
    return {
      id,
      queue: fields.queue,
      jobClass: fields.jobClass,
      payload: fields.payload,
      attempts,
      maxAttempts: parseInt(fields.maxAttempts, 10),
      availableAt: parseInt(fields.availableAt, 10),
      reservedAt: Math.floor(Date.now() / 1000),
      createdAt: parseInt(fields.createdAt, 10),
    };
  }

  private key(suffix: string): string {
    return `${this.prefix}${suffix}`;
  }

  private jobKey(id: number): string {
    return `${this.prefix}job:${id}`;
  }

  private pendingKey(queue: string): string {
    return `${this.prefix}pending:${queue}`;
  }

  private delayedKey(queue: string): string {
    return `${this.prefix}delayed:${queue}`;
  }

  private reservedKey(queue: string): string {
    return `${this.prefix}reserved:${queue}`;
  }
}
