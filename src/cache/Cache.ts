import type { CacheRememberOptions, CacheStore } from "./CacheStore.js";

export interface CacheConfig {
  store: CacheStore;
  prefix?: string;
  defaultTtl?: number;
}

export class Cache {
  private static store?: CacheStore;
  private static prefix = "";
  private static defaultTtl?: number;

  static configure(config: CacheConfig): void {
    this.store = config.store;
    this.prefix = config.prefix ?? "";
    this.defaultTtl = config.defaultTtl;
  }

  static getStore(): CacheStore {
    if (!this.store) {
      throw new Error("Cache has not been configured. Import from @bunnykit/orm/cache and call Cache.configure({ store }) before using cache APIs.");
    }
    return this.store;
  }

  static async get<T = unknown>(key: string): Promise<T | null> {
    return await this.getStore().get<T>(this.prefixKey(key));
  }

  static async set<T = unknown>(key: string, value: T, options: CacheRememberOptions = {}): Promise<void> {
    await this.getStore().set(this.prefixKey(key), value, this.prefixOptions(options));
  }

  static async remember<T>(key: string, value: T | Promise<T> | (() => T | Promise<T>), ttl?: number): Promise<T>;
  static async remember<T>(key: string, value: T | Promise<T> | (() => T | Promise<T>), options?: CacheRememberOptions): Promise<T>;
  static async remember<T>(
    key: string,
    valueOrResolver: T | Promise<T> | (() => T | Promise<T>),
    ttlOrOptions?: number | CacheRememberOptions
  ): Promise<T> {
    const normalized = typeof ttlOrOptions === "number" ? { ttl: ttlOrOptions } : ttlOrOptions ?? {};
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await (typeof valueOrResolver === "function"
      ? (valueOrResolver as () => T | Promise<T>)()
      : valueOrResolver);
    await this.set(key, value, {
      ...normalized,
      ttl: normalized.ttl ?? this.defaultTtl,
    });
    return value;
  }

  static async forget(key: string): Promise<void> {
    await this.getStore().forget(this.prefixKey(key));
  }

  static async forgetTag(tag: string): Promise<void> {
    await this.getStore().forgetTag(this.prefixKey(tag));
  }

  static async forgetTags(tags: string[]): Promise<void>;
  static async forgetTags(...tags: string[]): Promise<void>;
  static async forgetTags(...tags: [string[]] | string[]): Promise<void> {
    const list = Array.isArray(tags[0]) ? tags[0] : tags as string[];
    await this.getStore().forgetTags(list.map((tag) => this.prefixKey(tag)));
  }

  static async flush(): Promise<void> {
    await this.getStore().flush();
  }

  private static prefixKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private static prefixOptions(options: CacheRememberOptions): CacheRememberOptions {
    const tags = typeof options.tags === "string" ? [options.tags] : options.tags;
    return {
      ...options,
      ttl: options.ttl ?? this.defaultTtl,
      tags: tags?.map((tag) => this.prefixKey(tag)),
    };
  }
}
