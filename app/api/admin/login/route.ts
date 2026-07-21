import { env } from "cloudflare:workers";
import { adminConfiguration, adminCookie, createAdminToken } from "../../../lib/admin-auth";
import {
  activeLoginFailure,
  IP_BLOCK_MS,
  IP_FAILURE_LIMIT,
  recordLoginFailure,
  recordPasswordFailure,
} from "../../../lib/admin-login-failures";

const encoder = new TextEncoder();
const DUMMY_SALT = new Uint8Array(16);
const DUMMY_HASH = "0".repeat(64);

type AdminIdentity = {
  username: string;
  password_hash: string;
  password_salt: string;
  role: "owner" | "level10";
};

const hex = (value: Uint8Array) => Array.from(value, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => new Uint8Array(value.match(/.{1,2}/g)?.map((item) => parseInt(item, 16)) ?? []);
const safeEqual = (left: string, right: string) => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
};

async function hashPassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  return hex(new Uint8Array(bits));
}

function requestIp(request: Request) {
  return (request.headers.get("cf-connecting-ip")
    || request.headers.get("x-forwarded-for")?.split(",")[0]
    || request.headers.get("x-real-ip")
    || "local-preview").trim().slice(0, 128);
}

function secondsRemaining(blockedUntil: string) {
  return Math.max(1, Math.ceil((Date.parse(blockedUntil) - Date.now()) / 1000));
}

function lockedResponse(message: string, blockedUntil: string) {
  const retryAfter = secondsRemaining(blockedUntil);
  return Response.json({ error: message, retryAfterSeconds: retryAfter }, {
    status: 429,
    headers: { "Retry-After": String(retryAfter) },
  });
}

async function findAdmin(username: string): Promise<AdminIdentity | null> {
  const owner = await env.DB.prepare(
    "SELECT username,password_hash,password_salt FROM admin_owners WHERE username=? COLLATE NOCASE AND status='active'",
  ).bind(username).first<Omit<AdminIdentity, "role">>();
  if (owner) return { ...owner, role: "owner" };
  const member = await env.DB.prepare(
    "SELECT username,password_hash,password_salt FROM users WHERE username=? COLLATE NOCASE AND level=10 AND status='active'",
  ).bind(username).first<Omit<AdminIdentity, "role">>();
  return member ? { ...member, role: "level10" } : null;
}

export async function POST(request: Request) {
  try {
    const configuration = adminConfiguration(env, request);
    if (!configuration) return Response.json({ error: "로그인 설정을 확인해 주세요." }, { status: 503 });

    const ip = requestIp(request);
    const ipFailure = await activeLoginFailure(env.DB, "admin_ip_login_failures", "ip", ip);
    if (ipFailure?.blocked_until) return lockedResponse("잠시 후 다시 시도해 주세요.", ipFailure.blocked_until);

    const input = await request.json() as Record<string, string>;
    const username = String(input.username ?? "").trim().slice(0, 64);
    const password = String(input.password ?? "");
    const identity = username ? await findAdmin(username) : null;

    if (identity) {
      const accountKey = identity.username.toLowerCase();
      const accountFailure = await activeLoginFailure(env.DB, "admin_account_login_failures", "username", accountKey);
      if (accountFailure?.blocked_until) {
        const ipBlockedUntil = await recordLoginFailure(env.DB, "admin_ip_login_failures", "ip", ip, IP_FAILURE_LIMIT, IP_BLOCK_MS);
        if (ipBlockedUntil) return lockedResponse("잠시 후 다시 시도해 주세요.", ipBlockedUntil);
        return lockedResponse("잠시 후 다시 시도해 주세요.", accountFailure.blocked_until);
      }
    }

    const suppliedHash = await hashPassword(password, identity ? bytes(identity.password_salt) : DUMMY_SALT);
    if (!identity) {
      void safeEqual(suppliedHash, DUMMY_HASH);
      const blockedUntil = await recordLoginFailure(env.DB, "admin_ip_login_failures", "ip", ip, IP_FAILURE_LIMIT, IP_BLOCK_MS);
      if (blockedUntil) return lockedResponse("잠시 후 다시 시도해 주세요.", blockedUntil);
      return Response.json({ error: "아이디 또는 비밀번호를 확인해 주세요." }, { status: 401 });
    }

    const accountKey = identity.username.toLowerCase();
    if (!safeEqual(suppliedHash, identity.password_hash)) {
      const { ipBlockedUntil, accountBlockedUntil } = await recordPasswordFailure(env.DB, ip, accountKey);
      if (ipBlockedUntil) return lockedResponse("잠시 후 다시 시도해 주세요.", ipBlockedUntil);
      if (accountBlockedUntil) return lockedResponse("잠시 후 다시 시도해 주세요.", accountBlockedUntil);
      return Response.json({ error: "아이디 또는 비밀번호를 확인해 주세요." }, { status: 401 });
    }

    await env.DB.batch([
      env.DB.prepare("DELETE FROM admin_ip_login_failures WHERE ip=?").bind(ip),
      env.DB.prepare("DELETE FROM admin_account_login_failures WHERE username=?").bind(accountKey),
    ]);
    const token = await createAdminToken(identity.username, identity.role, configuration.secret);
    return Response.json({
      ok: true,
      operator: {
        username: identity.username,
        role: identity.role,
        level: 10,
        canManageAdmins: identity.role === "owner",
      },
    }, { headers: { "Set-Cookie": adminCookie(token, request) } });
  } catch (error) {
    console.error("Admin login failed", error);
    return Response.json({ error: "로그인 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}
