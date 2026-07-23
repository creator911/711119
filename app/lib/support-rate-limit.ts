type RateLimitDatabase = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

export type SupportWriteAction = "inquiry" | "reply";

const LIMITS: Record<SupportWriteAction, { maximum: number; windowMs: number }> = {
  inquiry: { maximum: 5, windowMs: 60 * 60 * 1000 },
  reply: { maximum: 20, windowMs: 10 * 60 * 1000 },
};

export type SupportRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

export async function consumeSupportWriteLimit(
  database: RateLimitDatabase,
  userId: number,
  action: SupportWriteAction,
  now = new Date(),
): Promise<SupportRateLimitResult> {
  const { maximum, windowMs } = LIMITS[action];
  const nowMs = now.getTime();
  const windowStart = Math.floor(nowMs / windowMs) * windowMs;
  const actorKey = `member:${userId}`;
  const row = await database.prepare(`
    INSERT INTO support_write_rate_limits(actor_key,action,window_start,request_count,updated_at)
    VALUES(?,?,?,1,?)
    ON CONFLICT(actor_key,action,window_start) DO UPDATE SET
      request_count=support_write_rate_limits.request_count+1,
      updated_at=excluded.updated_at
    RETURNING request_count AS requestCount
  `).bind(actorKey, action, windowStart, now.toISOString()).first<{ requestCount: number }>();
  if (!row) throw new Error("고객센터 요청 제한을 확인하지 못했습니다.");

  // Keep the bucket table bounded without adding a cleanup write to every request.
  if ((userId + Math.floor(nowMs / 1000)) % 128 === 0) {
    const retentionStart = nowMs - 2 * 24 * 60 * 60 * 1000;
    await database.prepare(`
      DELETE FROM support_write_rate_limits
      WHERE rowid IN (
        SELECT rowid FROM support_write_rate_limits
        WHERE window_start < ?
        ORDER BY window_start
        LIMIT 500
      )
    `)
      .bind(retentionStart).run().catch(() => undefined);
  }

  const requestCount = Math.max(1, Number(row.requestCount));
  return {
    allowed: requestCount <= maximum,
    limit: maximum,
    remaining: Math.max(0, maximum - requestCount),
    retryAfterSeconds: Math.max(1, Math.ceil((windowStart + windowMs - nowMs) / 1000)),
  };
}

export function supportRateLimitResponse(result: SupportRateLimitResult) {
  return Response.json(
    { error: "고객센터 요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
    {
      status: 429,
      headers: {
        "Cache-Control": "private, no-store",
        "Retry-After": String(result.retryAfterSeconds),
        "X-RateLimit-Limit": String(result.limit),
        "X-RateLimit-Remaining": String(result.remaining),
      },
    },
  );
}
