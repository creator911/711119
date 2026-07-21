import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { isMemberLevel } from "../../../lib/member-level";

export async function PATCH(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const { id, nickname = "", points, level, status = "", isDirector, isPartner } = await request.json() as { id?: number; nickname?: string; points?: number; level?: number; status?: string; isDirector?: boolean; isPartner?: boolean };
    const normalizedNickname = nickname.trim();
    if (!Number.isInteger(id) || !Number.isInteger(points) || Number(points) < 0 || Number(points) > 1_000_000_000 || !isMemberLevel(level) || normalizedNickname.length < 2 || normalizedNickname.length > 12 || !["active", "suspended"].includes(status) || (isDirector !== undefined && typeof isDirector !== "boolean") || (isPartner !== undefined && typeof isPartner !== "boolean")) {
      return Response.json({ error: "회원 정보 형식을 확인해 주세요." }, { status: 400 });
    }
    const current = await env.DB.prepare("SELECT level,is_director AS isDirector,is_partner AS isPartner FROM users WHERE id=?").bind(id).first<{ level: number; isDirector: number; isPartner: number }>();
    if (!current) return Response.json({ error: "회원을 찾을 수 없습니다." }, { status: 404 });
    if (!operator.canManageAdmins && current.level !== level && (current.level === 10 || level === 10)) {
      return Response.json({ error: "Lv.10 관리자 지정·해제는 오너 계정만 할 수 있습니다." }, { status: 403 });
    }
    const nextIsDirector = typeof isDirector === "boolean" ? isDirector : Boolean(current.isDirector);
    const nextIsPartner = typeof isPartner === "boolean" ? isPartner : Boolean(current.isPartner);
    if (nextIsPartner && !nextIsDirector) {
      return Response.json({ error: "실장으로 지정된 회원만 제휴회원으로 변경할 수 있습니다." }, { status: 409 });
    }
    const statements = [env.DB.prepare("UPDATE users SET nickname = ?, points = ?, level = ?, status = ?, is_director = ?, is_partner = ? WHERE id = ?").bind(normalizedNickname, points, level, status, nextIsDirector ? 1 : 0, nextIsPartner ? 1 : 0, id)];
    if (current.isDirector && !nextIsDirector) statements.push(env.DB.prepare("DELETE FROM director_regions WHERE user_id=?").bind(id));
    if (current.isDirector && !nextIsDirector || current.isPartner && !nextIsPartner) statements.push(env.DB.prepare("DELETE FROM featured_vendor_permissions WHERE user_id=?").bind(id));
    const results = await env.DB.batch(statements);
    const result = results[0];
    if (!result.meta.changes) return Response.json({ error: "회원 정보가 변경되지 않았습니다." }, { status: 409 });
    return Response.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "이미 사용 중인 닉네임입니다." }, { status: 409 });
    console.error("Admin member update failed", error);
    return Response.json({ error: "회원 정보 저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}
