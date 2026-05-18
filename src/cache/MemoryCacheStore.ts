import type { CacheRememberOptions, CacheStore } from "./CacheStore.js";

interface MemoryCacheEntry {
  value: string;
  expiresAt?: number;
  tags: Set<string>;
}

export class MemoryCacheStore implements CacheStore {
  private entries = new Map<string, MemoryCacheEntry>();
  private tagKeys = new Map<string, Set<string>>();

  async get<T = unknown>(key: string): Promise<T | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      await this.forget(key);
      return null;
    }
    return JSON.parse(entry.value) as T;
  }

  async set<T = unknown>(key: string, value: T, options: CacheRememberOptions = {}): Promise<void> {
    const existing = this.entries.get(key);
    if (existing) {
      for (const tag of existing.tags) {
        this.tagKeys.get(tag)?.delete(key);
      }
    }

    const optionTags = typeof options.tags === "string" ? [options.tags] : options.tags ?? [];
    const tags = new Set(optionTags);
    this.entries.set(key, {
      value: JSON.stringify(value),
      expiresAt: options.ttl ? Date.now() + options.ttl * 1000 : undefined,
      tags,
    });

    for (const tag of tags) {
      let keys = this.tagKeys.get(tag);
      if (!keys) {
        keys = new Set<string>();
        this.tagKeys.set(tag, keys);
      }
      keys.add(key);
    }
  }

  async forget(key: string): Promise<void> {
    this.entries.delete(key);
  }

  async forgetTag(tag: string): Promise<void> {
    const keys = this.tagKeys.get(tag);
    if (!keys) return;
    for (const key of keys) {
      this.entries.delete(key);
    }
    this.tagKeys.delete(tag);
  }

  async forgetTags(tags: string[]): Promise<void> {
    for (const tag of tags) {
      await this.forgetTag(tag);
    }
  }

  async flush(): Promise<void> {
    this.entries.clear();
    this.tagKeys.clear();
  }
}
