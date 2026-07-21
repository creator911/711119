import { env } from "cloudflare:workers";

const encoder = new TextEncoder();
const ipOf = (request: Request) => request.headers.get("cf-connecting-ip") || request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "local-preview";
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
const bytes = (value: string) => new Uint8Array(value.match(/.{1,2}/g)?.map((item) => parseInt(item, 16)) ?? []);

async function hashPassword(password: string, salt: Uint8Array) {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: 100_000 }, key, 256);
  return hex(new Uint8Array(bits));
}

export async function POST(request: Request) {
  try {
    const { username = "", password = "" } = await request.json() as Record<string, string>;
    const user = await env.DB.prepare("SELECT id,username,nickname,password_hash,password_salt,points,level,status,first_login_ip FROM users WHERE username = ?").bind(username).first<Record<string, string | number | null>>();
    if (!user) return Response.json({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }, { status: 401 });
    const passwordMatches = await hashPassword(password, bytes(String(user.password_salt))) === user.password_hash;
    if (!passwordMatches) return Response.json({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }, { status: 401 });
    if (user.status === "suspended") return Response.json({ error: "이용이 정지 되셨습니다." }, { status: 403 });
    if (user.status !== "active") return Response.json({ error: "아이디 또는 비밀번호가 일치하지 않습니다." }, { status: 401 });
    const ip = ipOf(request);
    if (!user.first_login_ip) await env.DB.prepare("UPDATE users SET first_login_ip = ? WHERE id = ?").bind(ip, user.id).run();
    const token = hex(crypto.getRandomValues(new Uint8Array(32)));
    const expires = new Date(Date.now() + 1000 * 60 * 60 * 24 * 7);
    await env.DB.prepare("INSERT INTO sessions (token,user_id,ip,expires_at,created_at) VALUES (?,?,?,?,?)").bind(token, user.id, ip, expires.toISOString(), new Date().toISOString()).run();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    const attendance = await env.DB.prepare("SELECT id FROM attendance WHERE user_id = ? AND attendance_date = ?").bind(user.id, today).first();
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return Response.json({ user: { username: user.username, nickname: user.nickname, points: user.points, level: user.level, attended: Boolean(attendance) } }, { headers: { "Set-Cookie": `cn_session=${token}; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=604800` } });
  } catch (error) {
    console.error("Login failed", error);
    return Response.json({ error: "로그인 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
