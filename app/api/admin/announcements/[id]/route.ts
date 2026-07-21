import { env } from "cloudflare:workers";
import { adminSession } from "../../../../lib/admin-auth";

const parseId = (value: string) => {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const id = parseId((await context.params).id);
  if (!id) return Response.json({ error: "올바른 알림 번호가 아닙니다." }, { status: 400 });
  try {
    const payload = await request.json() as { status?: unknown };
    if (payload.status !== "cancelled") return Response.json({ error: "지원하지 않는 알림 상태입니다." }, { status: 400 });
    const changedAt = new Date().toISOString();
    const result = await env.DB.prepare("UPDATE system_announcements SET status='cancelled',updated_at=? WHERE id=? AND status='active'")
      .bind(changedAt, id).run();
    if (!result.meta.changes) return Response.json({ error: "취소할 수 있는 알림을 찾지 못했습니다." }, { status: 404 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Cancel system announcement failed", error);
    return Response.json({ error: "전체 알림 공지를 중단하지 못했습니다." }, { status: 500 });
  }
}
