/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
  interface Env {
    ASSETS: Fetcher;
    DB: D1Database;
    MEDIA: R2Bucket;
    CACHE?: {
      get(key: string): Promise<string | null>;
      set(key: string, value: string, options?: { ttlSeconds?: number; onlyIfAbsent?: boolean }): Promise<unknown>;
      delete(...keys: string[]): Promise<number>;
      incrementBy(key: string, amount: number, ttlSeconds?: number): Promise<number>;
      hashIncrementBy(key: string, field: string, amount: number): Promise<number>;
      hashGet(key: string, field: string): Promise<string | null>;
      hashEntries(key: string): Promise<Record<string, string>>;
      consumeHash(key: string, entries: Record<string, number>, totalKey?: string): Promise<number>;
      withLock<T>(key: string, action: () => Promise<T>, options?: Record<string, number>): Promise<T>;
    };
    APP_SURFACE?: string;
    NARA_DATABASE_DRIVER?: string;
    SESSION_CACHE_TTL_SECONDS?: string;
    ADMIN_SESSION_SECRET?: string;
    CAPTCHA_SECRET?: string;
  }
}
