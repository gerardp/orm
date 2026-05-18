export interface CacheRememberOptions {
  ttl?: number;
  tags?: string | string[];
}

export interface CacheStore {
  get<T = unknown>(key: string): Promise<T | null>;
  set<T = unknown>(key: string, value: T, options?: CacheRememberOptions): Promise<void>;
  forget(key: string): Promise<void>;
  forgetTag(tag: string): Promise<void>;
  forgetTags(tags: string[]): Promise<void>;
  flush(): Promise<void>;
}
