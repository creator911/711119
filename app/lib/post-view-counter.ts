type ViewCounterDatabase = D1Database;
type ViewCounterCache = {
  hashIncrementBy: (key: string, field: string, amount: number) => Promise<number>;
  hashGet: (key: string, field: string) => Promise<string | null>;
  hashEntries: (key: string) => Promise<Record<string, string>>;
  incrementBy: (key: string, amount: number, ttlSeconds?: number) => Promise<number>;
  consumeHash: (key: string, entries: Record<string, number>, totalKey?: string) => Promise<number>;
  withLock: <T>(key: string, action: () => Promise<T>, options?: Record<string, number>) => Promise<T>;
};

type TimerHandle = ReturnType<typeof setTimeout> & { unref?: () => void };

type CounterState = {
  pending: Map<number, number>;
  total: number;
  timer: TimerHandle | null;
  flushing: Promise<void> | null;
};

type CounterOptions = {
  flushIntervalMs?: number;
  flushThreshold?: number;
  maxBufferedViews?: number;
  onFlushError?: (error: unknown) => void;
};

const positiveInteger = (value: number | undefined, fallback: number) =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : fallback;

export function createPostViewCounter(options: CounterOptions = {}) {
  const flushIntervalMs = positiveInteger(options.flushIntervalMs, 2_000);
  const flushThreshold = positiveInteger(options.flushThreshold, 50);
  const maxBufferedViews = Math.max(flushThreshold, positiveInteger(options.maxBufferedViews, 1_000));
  const onFlushError = options.onFlushError ?? ((error: unknown) => console.error("Post view counter flush failed", error));
  const states = new WeakMap<ViewCounterDatabase, CounterState>();
  const distributedStates = new WeakMap<ViewCounterCache, { timer: TimerHandle | null; flushing: Promise<void> | null }>();
  const distributedHashKey = "post-views:pending";
  const distributedTotalKey = "post-views:total";

  const stateFor = (database: ViewCounterDatabase) => {
    let state = states.get(database);
    if (!state) {
      state = { pending: new Map(), total: 0, timer: null, flushing: null };
      states.set(database, state);
    }
    return state;
  };

  const schedule = (database: ViewCounterDatabase, state: CounterState) => {
    if (state.timer || !state.total) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void flush(database).catch(onFlushError);
    }, flushIntervalMs) as TimerHandle;
    state.timer.unref?.();
  };

  const flush = async (database: ViewCounterDatabase) => {
    const state = stateFor(database);
    if (state.flushing) return state.flushing;
    if (!state.total) return;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }

    const snapshot = new Map(state.pending);
    state.flushing = (async () => {
      const statements = [...snapshot].map(([postId, count]) => database
        .prepare("UPDATE posts SET views=views+? WHERE id=? AND status='published'")
        .bind(count, postId));
      await database.batch(statements);
      for (const [postId, flushedCount] of snapshot) {
        const current = state.pending.get(postId) ?? 0;
        const remaining = current - flushedCount;
        if (remaining > 0) state.pending.set(postId, remaining);
        else state.pending.delete(postId);
        state.total -= Math.min(current, flushedCount);
      }
      state.total = Math.max(0, state.total);
    })();

    try {
      await state.flushing;
    } finally {
      state.flushing = null;
      schedule(database, state);
    }
  };

  const record = async (database: ViewCounterDatabase, postId: number) => {
    if (!Number.isInteger(postId) || postId < 1) throw new TypeError("postId must be a positive integer");
    const state = stateFor(database);

    // Do not let a request race a database commit when it later projects the
    // buffered count into the response shown to the reader.
    if (state.flushing) await state.flushing;

    // Keep failed-database scenarios bounded. Once the hard cap is reached,
    // the next request must drain the existing buffer before adding more.
    if (state.total >= maxBufferedViews) await flush(database);
    if (state.total >= maxBufferedViews) throw new Error("Post view counter buffer is full");

    state.pending.set(postId, (state.pending.get(postId) ?? 0) + 1);
    state.total += 1;
    if (state.total >= flushThreshold) await flush(database);
    else schedule(database, state);
  };

  const distributedStateFor = (cache: ViewCounterCache) => {
    let state = distributedStates.get(cache);
    if (!state) {
      state = { timer: null, flushing: null };
      distributedStates.set(cache, state);
    }
    return state;
  };

  const flushDistributed = async (database: ViewCounterDatabase, cache: ViewCounterCache) => {
    const state = distributedStateFor(cache);
    if (state.flushing) return state.flushing;
    if (state.timer) {
      clearTimeout(state.timer);
      state.timer = null;
    }
    state.flushing = cache.withLock("post-views:flush", async () => {
      const raw = await cache.hashEntries(distributedHashKey);
      const snapshot = Object.fromEntries(Object.entries(raw)
        .map(([postId, count]) => [postId, Number(count)])
        .filter(([postId, count]) => Number.isInteger(Number(postId)) && Number(postId) > 0 && Number(count) > 0));
      const entries = Object.entries(snapshot);
      if (!entries.length) return;
      await database.batch(entries.map(([postId, count]) => database
        .prepare("UPDATE posts SET views=views+? WHERE id=? AND status='published'")
        .bind(count, Number(postId))));
      await cache.consumeHash(distributedHashKey, snapshot, distributedTotalKey);
    }, { ttlMilliseconds: 10_000, waitMilliseconds: 500 });
    try {
      await state.flushing;
    } finally {
      state.flushing = null;
    }
  };

  const scheduleDistributed = (database: ViewCounterDatabase, cache: ViewCounterCache) => {
    const state = distributedStateFor(cache);
    if (state.timer) return;
    state.timer = setTimeout(() => {
      state.timer = null;
      void flushDistributed(database, cache).catch(onFlushError);
    }, flushIntervalMs) as TimerHandle;
    state.timer.unref?.();
  };

  const recordDistributed = async (database: ViewCounterDatabase, postId: number, cache: ViewCounterCache) => {
    if (!Number.isInteger(postId) || postId < 1) throw new TypeError("postId must be a positive integer");
    await cache.hashIncrementBy(distributedHashKey, String(postId), 1);
    const total = await cache.incrementBy(distributedTotalKey, 1, 3_600);
    if (total >= flushThreshold || total >= maxBufferedViews) await flushDistributed(database, cache);
    else scheduleDistributed(database, cache);
  };

  const pending = (database: ViewCounterDatabase) => {
    const state = stateFor(database);
    return { total: state.total, posts: new Map(state.pending) };
  };

  const pendingFor = (database: ViewCounterDatabase, postId: number) =>
    stateFor(database).pending.get(postId) ?? 0;

  return { record, flush, pending, pendingFor, recordDistributed, flushDistributed };
}

const defaultPostViewCounter = createPostViewCounter();

export const recordPostView = async (
  database: ViewCounterDatabase,
  postId: number,
  cache?: ViewCounterCache | null,
) => {
  if (!cache) return defaultPostViewCounter.record(database, postId);
  try {
    return await defaultPostViewCounter.recordDistributed(database, postId, cache);
  } catch (error) {
    // A cache failover must not take the post-detail read path down. Keep a
    // bounded process-local buffer until Valkey becomes available again.
    console.error("Distributed post view buffer unavailable; using local fallback", error);
    return defaultPostViewCounter.record(database, postId);
  }
};

export const flushPostViews = (database: ViewCounterDatabase, cache?: ViewCounterCache | null) =>
  cache
    ? defaultPostViewCounter.flushDistributed(database, cache)
    : defaultPostViewCounter.flush(database);

export const pendingPostViews = (database: ViewCounterDatabase, postId: number) =>
  defaultPostViewCounter.pendingFor(database, postId);

export const pendingDistributedPostViews = async (cache: ViewCounterCache | null | undefined, postId: number) =>
  cache
    ? Number(await cache.hashGet("post-views:pending", String(postId)).catch(() => null) ?? 0)
    : 0;
