import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";

type AffiliateRow = {
  id: number;
  username: string;
  nickname: string;
  level: number;
  points: number;
  status: "active" | "suspended";
  isDirector: number;
  isPartner: number;
  createdAt: string;
};

export async function GET(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const [affiliates, permissions] = await Promise.all([
      env.DB.prepare(`
        SELECT id,username,nickname,level,points,status,
               is_director AS isDirector,is_partner AS isPartner,created_at AS createdAt
        FROM users
        WHERE is_partner=1
        ORDER BY id DESC
      `).all<AffiliateRow>(),
      env.DB.prepare(`
        SELECT user_id AS userId,slot
        FROM featured_vendor_permissions
        ORDER BY user_id,slot
      `).all<{ userId: number; slot: number }>(),
    ]);
    return Response.json({
      affiliates: affiliates.results.map((member) => ({
        ...member,
        isDirector: Boolean(member.isDirector),
        isPartner: Boolean(member.isPartner),
      })),
      assignments: permissions.results,
    });
  } catch (error) {
    console.error("Featured vendor permission load failed", error);
    return Response.json({ error: "제휴회원 슬롯 권한을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const payload = await request.json() as { userId?: unknown; slots?: unknown };
    const userId = payload.userId;
    if (!Number.isInteger(userId) || Number(userId) < 1 || !Array.isArray(payload.slots) || payload.slots.length > 4) {
      return Response.json({ error: "저장할 제휴회원과 슬롯을 확인해 주세요." }, { status: 400 });
    }
    if (payload.slots.some((slot) => typeof slot !== "number" || !Number.isInteger(slot) || slot < 1 || slot > 4)) {
      return Response.json({ error: "제휴 슬롯은 1번부터 4번까지만 선택할 수 있습니다." }, { status: 400 });
    }
    const slots = [...new Set(payload.slots as number[])].sort((left, right) => left - right);
    const member = await env.DB.prepare(`
      SELECT id,status,is_director AS isDirector,is_partner AS isPartner
      FROM users WHERE id=?
    `).bind(userId).first<{ id: number; status: string; isDirector: number; isPartner: number }>();
    if (!member) return Response.json({ error: "제휴회원을 찾을 수 없습니다." }, { status: 404 });
    if (member.status !== "active" || !member.isDirector || !member.isPartner) {
      return Response.json({ error: "활성 상태의 실장·제휴회원에게만 슬롯 권한을 배정할 수 있습니다." }, { status: 409 });
    }
    const now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM featured_vendor_permissions WHERE user_id=?").bind(userId),
      ...slots.map((slot) => env.DB.prepare(`
        INSERT INTO featured_vendor_permissions(user_id,slot,created_at)
        VALUES(?,?,?)
      `).bind(userId, slot, now)),
    ]);
    return Response.json({ ok: true, userId, slots });
  } catch (error) {
    console.error("Featured vendor permission update failed", error);
    return Response.json({ error: "제휴회원 슬롯 권한을 저장하지 못했습니다." }, { status: 500 });
  }
}
