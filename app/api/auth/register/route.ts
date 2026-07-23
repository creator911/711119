import { env } from "cloudflare:workers";
import { CAPTCHA_COOKIE, captchaSecret, clearCaptchaCookie, readCookie, verifyCaptchaToken } from "../../../lib/captcha";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../../lib/distributed-rate-limit";
import { isUniqueConstraintError } from "../../../lib/database-errors";

const encoder = new TextEncoder();
const ipOf = (request: Request) => request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local-preview";
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
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

export async function POST(request: Request) {
  try {
    const ip = ipOf(request);
    const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "member-register", ip, 30, 3_600);
    if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
    const { username = "", nickname = "", password = "", passwordConfirm = "", captchaAnswer = "" } = await request.json() as Record<string, string>;
    if (!/^[a-zA-Z0-9_]{4,20}$/.test(username) || nickname.trim().length < 2 || password.length < 8) return Response.json({ error: "입력 형식을 확인해 주세요." }, { status: 400 });
    if (password !== passwordConfirm) return Response.json({ error: "비밀번호와 비밀번호 확인이 일치하지 않습니다." }, { status: 400 });
    const captchaValid = await verifyCaptchaToken(readCookie(request, CAPTCHA_COOKIE), captchaAnswer.trim(), captchaSecret(env));
    if (!captchaValid) return Response.json({ error: "자동 등록 방지 숫자를 다시 확인해 주세요." }, { status: 400 });
    const blocked = await env.DB.prepare("SELECT ip FROM blocked_ips WHERE ip = ? LIMIT 1").bind(ip).first();
    if (blocked) return Response.json({ error: "차단된 IP에서는 가입할 수 없습니다." }, { status: 409 });
    const existingUsername = await env.DB.prepare("SELECT id FROM users WHERE username = ? LIMIT 1").bind(username).first();
    if (existingUsername) return Response.json({ error: "이미 사용 중인 아이디입니다." }, { status: 409 });
    const salt = crypto.getRandomValues(new Uint8Array(16));
    await env.DB.prepare("INSERT INTO users (username,nickname,password_hash,password_salt,signup_ip,points,role,status,created_at) VALUES (?,?,?,?,?,0,'member','active',?)").bind(username, nickname.trim(), await hashPassword(password, salt), hex(salt), ip, new Date().toISOString()).run();
    return Response.json({ ok: true }, { status: 201, headers: { "Set-Cookie": clearCaptchaCookie(request) } });
  } catch (error) {
    if (isUniqueConstraintError(error)) return Response.json({ error: "이미 사용 중인 아이디 또는 닉네임입니다." }, { status: 409 });
    console.error("Registration failed", error);
    return Response.json({ error: "회원가입 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
