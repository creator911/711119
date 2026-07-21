import { env } from "cloudflare:workers";
import { isAdminRequest } from "../../../lib/admin-auth";

const validIp = (value: string) => /^[0-9a-fA-F:.]{3,45}$/.test(value);

export async function POST(request: Request) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const { ip = "", reason = "" } = await request.json() as Record<string, string>;
    const normalizedIp = ip.trim();
    const normalizedReason = reason.trim();
    if (!validIp(normalizedIp) || normalizedReason.length < 2 || normalizedReason.length > 80) return Response.json({ error: "IP와 차단 사유를 확인해 주세요." }, { status: 400 });
    await env.DB.prepare("INSERT INTO blocked_ips (ip,reason,created_at) VALUES (?,?,?) ON CONFLICT(ip) DO UPDATE SET reason = excluded.reason, created_at = excluded.created_at").bind(normalizedIp, normalizedReason, new Date().toISOString()).run();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Admin IP block failed", error);
    return Response.json({ error: "IP 차단 처리 중 오류가 발생했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const { ip = "" } = await request.json() as Record<string, string>;
  if (!validIp(ip.trim())) return Response.json({ error: "IP 형식을 확인해 주세요." }, { status: 400 });
  await env.DB.prepare("DELETE FROM blocked_ips WHERE ip = ?").bind(ip.trim()).run();
  return Response.json({ ok: true });
}
