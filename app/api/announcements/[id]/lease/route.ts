import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { eligibleAnnouncementMember } from "../../../../lib/system-announcements";

type LeaseBody = { leaseToken?: unknown };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await memberFromSession(request);
  if (!eligibleAnnouncementMember(member)) {
    return Response.json({ error: "알림 갱신 대상 회원이 아닙니다." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "올바른 알림 번호가 아닙니다." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }

  let body: LeaseBody;
  try { body = await request.json() as LeaseBody; }
  catch { return Response.json({ error: "요청 형식을 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } }); }
  const leaseToken = typeof body.leaseToken === "string" ? body.leaseToken : "";
  if (leaseToken.length < 20 || leaseToken.length > 40 || !Number.isFinite(Date.parse(leaseToken))) {
    return Response.json({ error: "알림 전달 정보를 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }

  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // Keep the token monotonic even when claim and heartbeat land in the same
  // millisecond; otherwise the previous token could renew the lease twice.
  const renewedAt = new Date(Math.max(nowMs, Date.parse(leaseToken) + 1)).toISOString();
  try {
    const renewed = await env.DB.prepare(`
      UPDATE system_announcement_receipts
      SET delivered_at=?
      WHERE announcement_id=? AND user_id=?
        AND acknowledged_at IS NULL AND delivered_at=?
        AND EXISTS (
          SELECT 1 FROM system_announcements a
          WHERE a.id=system_announcement_receipts.announcement_id
            AND a.status='active' AND a.starts_at<=? AND a.ends_at>?
        )
      RETURNING delivered_at AS leaseToken
    `).bind(renewedAt, id, member!.id, leaseToken, now, now).first<{ leaseToken: string }>();
    if (!renewed) {
      return Response.json(
        { error: "알림 전달 권한이 만료되었습니다.", inactive: true },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return Response.json(renewed, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Renew member system announcement lease failed", error);
    return Response.json({ error: "알림 전달 상태를 갱신하지 못했습니다." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
