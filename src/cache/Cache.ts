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

  static async remember<T>(key: string, options: CacheRememberOptions | number | undefined, callback: () => T | Promise<T>): Promise<T> {
    const normalized = typeof options === "number" ? { ttl: options } : options ?? {};
    const cached = await this.get<T>(key);
    if (cached !== null) return cached;
    const value = await callback();
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

  static async forgetTags(tags: string[]): Promise<void> {
    await this.getStore().forgetTags(tags.map((tag) => this.prefixKey(tag)));
  }

  static async flush(): Promise<void> {
    await this.getStore().flush();
  }

  private static prefixKey(key: string): string {
    return this.prefix ? `${this.prefix}${key}` : key;
  }

  private static prefixOptions(options: CacheRememberOptions): CacheRememberOptions {
    return {
      ...options,
      ttl: options.ttl ?? this.defaultTtl,
      tags: options.tags?.map((tag) => this.prefixKey(tag)),
    };
  }
}

