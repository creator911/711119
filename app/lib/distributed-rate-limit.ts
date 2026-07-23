type DistributedRateLimitCache = {
  incrementBy: (key: string, amount: number, ttlSeconds?: number) => Promise<number>;
};

export type DistributedRateLimitResult = {
  allowed: boolean;
  limit: number;
  remaining: number;
  retryAfterSeconds: number;
};

async function subjectDigest(subject: string) {
  const bytes = new TextEncoder().encode(subject);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function consumeDistributedRateLimit(
  cache: DistributedRateLimitCache | null | undefined,
  scope: string,
  subject: string,
  limit: number,
  windowSeconds: number,
): Promise<DistributedRateLimitResult | null> {
  if (!cache) return null;
  const boundedLimit = Math.max(1, Math.trunc(limit));
  const boundedWindow = Math.max(1, Math.trunc(windowSeconds));
  try {
    const digest = await subjectDigest(subject);
    const count = await cache.incrementBy(`rate:${scope}:${digest}`, 1, boundedWindow);
    return {
      allowed: count <= boundedLimit,
      limit: boundedLimit,
      remaining: Math.max(0, boundedLimit - count),
      retryAfterSeconds: boundedWindow,
    };
  } catch {
    // Durable database constraints and existing account-specific limits remain
    // authoritative while Valkey is failing over.
    return null;
  }
}

export function distributedRateLimitResponse(
  result: DistributedRateLimitResult,
  message = "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
) {
  return Response.json({ error: message, retryAfterSeconds: result.retryAfterSeconds }, {
    status: 429,
    headers: {
      "Cache-Control": "private, no-store",
      "Retry-After": String(result.retryAfterSeconds),
      "X-RateLimit-Limit": String(result.limit),
      "X-RateLimit-Remaining": String(result.remaining),
    },
  });
}
