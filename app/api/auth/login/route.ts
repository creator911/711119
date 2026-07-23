import { env } from "cloudflare:workers";
import { pruneExpiredSessions } from "../../../lib/auth-maintenance";
import { cacheMemberSession } from "../../../lib/member-auth";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../lib/distributed-rate-limit";
import {
  activeMemberAccountFailure,
  activeMemberIpFailure,
  maybePruneMemberLoginFailures,
  recordMemberPasswordFailure,
  shouldRunMemberLoginMaintenance,
} from "../../../lib/member-login-failures";

const encoder = new TextEncoder();
const DUMMY_SALT = new Uint8Array(16);
const DUMMY_HASH = "0".repeat(64);
const INVALID_CREDENTIALS = "아이디 또는 비밀번호가 일치하지 않습니다.";
const TOO_MANY_ATTEMPTS = "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.";
const ipOf = (request: Request) => (
  request.headers.get("cf-connecting-ip")
  || request.headers.get("x-forwarded-for")?.split(",")[0]
  || request.headers.get("x-real-ip")
  || "local-preview"
).trim().slice(0, 128);
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => new Uint8Array(value.match(/.{1,2}/g)?.map((item) => parseInt(item, 16)) ?? []);
const cryptoBuffer = (value: Uint8Array) => {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
};

async function hashPassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: cryptoBuffer(salt), iterations: 100_000 }, key, 256);
  return hex(new Uint8Array(bits));
}

const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

function lockedResponse(blockedUntil: string) {
  const retryAfter = Math.max(1, Math.ceil((Date.parse(blockedUntil) - Date.now()) / 1000));
  return Response.json({ error: TOO_MANY_ATTEMPTS, retryAfterSeconds: retryAfter }, {
    status: 429,
    headers: { "Cache-Control": "private, no-store", "Retry-After": String(retryAfter) },
  });
}

type LoginUser = {
  id: number;
  username: string;
  nickname: string;
  password_hash: string;
  password_salt: string;
  points: number;
  level: number;
  role: string;
  status: string;
  first_login_ip: string | null;
};

export async function POST(request: Request) {
  try {
    const ip = ipOf(request);
    const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "member-login", ip, 60, 60);
    if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
    const ipFailure = await activeMemberIpFailure(env.DB, ip);
    if (ipFailure?.blocked_until) return lockedResponse(ipFailure.blocked_until);

    const input = await request.json() as Record<string, string>;
    const username = String(input.username ?? "").trim().slice(0, 64);
    const password = String(input.password ?? "");
    const user = username
      ? await env.DB.prepare("SELECT id,username,nickname,password_hash,password_salt,points,level,role,status,first_login_ip FROM users WHERE username = ?")
        .bind(username).first<LoginUser>()
      : null;
    // Member usernames are stored with SQLite's default case-sensitive
    // collation, so keep the canonical case here as well. Lower-casing this
    // key would let two valid accounts such as `Member` and `member` lock one
    // another even though they are distinct login identities.
    const accountKey = String(user?.username ?? username);
    const accountFailure = await activeMemberAccountFailure(env.DB, accountKey);
    if (accountFailure?.blocked_until) return lockedResponse(accountFailure.blocked_until);

    const passwordMatches = await hashPassword(password, user ? bytes(user.password_salt) : DUMMY_SALT)
      .then((suppliedHash) => safeEqual(suppliedHash, user?.password_hash ?? DUMMY_HASH));
    const rejectInvalidCredentials = async () => {
      const { ipBlockedUntil, accountBlockedUntil } = await recordMemberPasswordFailure(env.DB, ip, accountKey);
      await maybePruneMemberLoginFailures(env.DB, `${ip}:${accountKey}`).catch(() => undefined);
      if (ipBlockedUntil) return lockedResponse(ipBlockedUntil);
      if (accountBlockedUntil) return lockedResponse(accountBlockedUntil);
      return Response.json({ error: INVALID_CREDENTIALS }, { status: 401, headers: { "Cache-Control": "private, no-store" } });
    };
    if (!passwordMatches) return rejectInvalidCredentials();
    if (!user) return rejectInvalidCredentials();

    await env.DB.prepare("DELETE FROM member_account_login_failures WHERE username=?").bind(accountKey).run();
    if (user.status === "suspended") return Response.json({ error: "이용이 정지 되셨습니다." }, { status: 403 });
    if (user.status !== "active") return Response.json({ error: INVALID_CREDENTIALS }, { status: 401 });
    const maintenanceKey = `${ip}:${accountKey}`;
    const maintenanceNow = Date.now();
    if (shouldRunMemberLoginMaintenance(maintenanceKey, maintenanceNow)) {
      await Promise.all([
        pruneExpiredSessions(env.DB).catch(() => undefined),
        maybePruneMemberLoginFailures(env.DB, maintenanceKey, maintenanceNow).catch(() => undefined),
      ]);
    }
    if (!user.first_login_ip) await env.DB.prepare("UPDATE users SET first_login_ip = ? WHERE id = ?").bind(ip, user.id).run();
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    await env.DB.prepare("INSERT INTO sessions (token,user_id,ip,expires_at,created_at) VALUES (?,?,?,?,?)").bind(token, user.id, ip, expires.toISOString(), new Date().toISOString()).run();
    await cacheMemberSession(token, {
      id: user.id,
      username: user.username,
      nickname: user.nickname,
      points: user.points,
      level: user.level,
      role: user.role,
    });
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const attendance = await env.DB.prepare("SELECT id FROM attendance WHERE user_id = ? AND attendance_date = ?").bind(user.id, today).first();
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return Response.json({ user: { username: user.username, nickname: user.nickname, points: user.points, level: user.level, attended: Boolean(attendance) } }, { headers: { "Set-Cookie": `cn_session=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=604800` } });
  } catch (error) {
    console.error("Login failed", error);
    return Response.json({ error: "로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
