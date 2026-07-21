import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";

const SETTING_KEY = "main_domain";
const DEFAULT_MAIN_DOMAIN = "https://nara001.co.kr";

function normalizeDomain(value: string) {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 2048) throw new Error("도메인 주소를 확인해 주세요.");
  const candidate = /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    throw new Error("도메인 주소를 확인해 주세요.");
  }
  if (!(["http:", "https:"] as string[]).includes(url.protocol) || !url.hostname || url.username || url.password) {
    throw new Error("http:// 또는 https:// 형식의 올바른 도메인을 입력해 주세요.");
  }
  return url.origin;
}

async function initializeSiteSettings() {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TEXT NOT NULL
    )
  `).run();
  await env.DB.prepare(`
    INSERT OR IGNORE INTO site_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)
  `).bind(SETTING_KEY, DEFAULT_MAIN_DOMAIN, "system", new Date().toISOString()).run();
}

async function currentDomain() {
  await initializeSiteSettings();
  const row = await env.DB.prepare("SELECT value FROM site_settings WHERE key=? LIMIT 1").bind(SETTING_KEY).first<{ value: string }>();
  return row?.value ?? DEFAULT_MAIN_DOMAIN;
}

export async function GET(request: Request) {
  if (!await adminSession(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    return Response.json({ url: await currentDomain() });
  } catch (error) {
    console.error("Load main domain failed", error);
    return Response.json({ error: "메인페이지 도메인을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const session = await adminSession(request, env);
  if (!session) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const body = await request.json() as { url?: unknown };
    const url = normalizeDomain(typeof body.url === "string" ? body.url : "");
    await initializeSiteSettings();
    await env.DB.prepare(`
      INSERT INTO site_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    `).bind(SETTING_KEY, url, session.username, new Date().toISOString()).run();
    return Response.json({ ok: true, url });
  } catch (error) {
    const message = error instanceof Error ? error.message : "메인페이지 도메인을 저장하지 못했습니다.";
    return Response.json({ error: message }, { status: message.includes("도메인") ? 400 : 500 });
  }
}
