import { env } from "cloudflare:workers";

export type MemberSession = {
  id: number;
  username: string;
  nickname: string;
  points: number;
  level: number;
  role: string;
};

type SessionCache = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ttlSeconds?: number }) => Promise<unknown>;
  delete: (...keys: string[]) => Promise<unknown>;
  incrementBy: (key: string, amount: number, ttlSeconds?: number) => Promise<number>;
};
type CachedMemberSession = MemberSession & { _generation: string };

const tokenOf = (request: Request) => request.headers.get("cookie")?.match(/(?:^|; )cn_session=([^;]+)/)?.[1];

async function sessionCacheKey(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return `session:${Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

const cache = () => (env as unknown as { CACHE?: SessionCache | null }).CACHE;
const memberGenerationKey = (userId: number) => `member-session-generation:${userId}`;
const sessionCacheTtlSeconds = () => {
  const configured = Number((env as unknown as { SESSION_CACHE_TTL_SECONDS?: string }).SESSION_CACHE_TTL_SECONDS ?? 60);
  return Number.isFinite(configured) ? Math.max(5, Math.min(300, Math.trunc(configured))) : 60;
};

export async function invalidateMemberSessionCache(token: string) {
  const binding = cache();
  if (!binding || !token) return;
  await binding.delete(await sessionCacheKey(token)).catch(() => undefined);
}

export async function cacheMemberSession(token: string, member: MemberSession) {
  const binding = cache();
  if (!binding || !token) return;
  try {
    const generation = await binding.get(memberGenerationKey(member.id)) ?? "0";
    const value: CachedMemberSession = { ...member, _generation: generation };
    await binding.set(await sessionCacheKey(token), JSON.stringify(value), {
      ttlSeconds: sessionCacheTtlSeconds(),
    });
  } catch {
    // PostgreSQL remains the source of truth during cache failover.
  }
}

export async function invalidateMemberSessionsByUserIds(userIds: number[]) {
  const binding = cache();
  if (!binding) return;
  const ids = [...new Set(userIds.filter((id) => Number.isInteger(id) && id > 0))];
  await Promise.all(ids.map((id) => binding.incrementBy(memberGenerationKey(id), 1).catch(() => 0)));
}

export async function memberFromSession(request: Request) {
  const token = tokenOf(request);
  if (!token) return null;
  const binding = cache();
  const key = binding ? await sessionCacheKey(token) : "";
  if (binding) {
    const cached = await binding.get(key).catch(() => null);
    if (cached) {
      try {
        const member = JSON.parse(cached) as CachedMemberSession;
        const generation = await binding.get(memberGenerationKey(member.id)).catch(() => undefined);
        if (generation !== undefined && member._generation === (generation ?? "0")) {
          return {
            id: member.id,
            username: member.username,
            nickname: member.nickname,
            points: member.points,
            level: member.level,
            role: member.role,
          };
        }
        await binding.delete(key).catch(() => undefined);
      } catch {
        await binding.delete(key).catch(() => undefined);
      }
    }
  }
  const member = await env.DB.prepare(`
    SELECT u.id, u.username, u.nickname, u.points, u.level, u.role
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'
  `).bind(token, new Date().toISOString()).first<MemberSession>();
  if (member && binding) await cacheMemberSession(token, member);
  return member;
}
