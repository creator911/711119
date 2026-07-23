import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { ANNOUNCEMENT_DELIVERY_LEASE_MS, eligibleAnnouncementMember } from "../../../../lib/system-announcements";

type AckBody = { deliveryLeaseToken?: unknown };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await memberFromSession(request);
  if (!eligibleAnnouncementMember(member)) {
    return Response.json({ error: "알림 확인 대상 회원이 아닙니다." }, { status: 403, headers: { "Cache-Control": "private, no-store" } });
  }
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return Response.json({ error: "올바른 알림 번호가 아닙니다." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }

  let body: AckBody;
  try { body = await request.json() as AckBody; }
  catch { return Response.json({ error: "요청 형식을 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } }); }
  const deliveryLeaseToken = typeof body.deliveryLeaseToken === "string" ? body.deliveryLeaseToken : "";
  if (deliveryLeaseToken.length < 20 || deliveryLeaseToken.length > 40 || !Number.isFinite(Date.parse(deliveryLeaseToken))) {
    return Response.json({ error: "알림 전달 정보를 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }

  const now = new Date().toISOString();
  const leaseExpiredBefore = new Date(Date.now() - ANNOUNCEMENT_DELIVERY_LEASE_MS).toISOString();
  try {
    // Token verification and acknowledgement are a single statement. A tab
    // whose lease was renewed/reclaimed elsewhere can never acknowledge the
    // new holder's notice with an older token.
    const acknowledged = await env.DB.prepare(`
      UPDATE system_announcement_receipts
      SET acknowledged_at=COALESCE(acknowledged_at,?)
      WHERE announcement_id=? AND user_id=? AND delivered_at=? AND delivered_at>?
        AND EXISTS (
          SELECT 1 FROM system_announcements a
          WHERE a.id=system_announcement_receipts.announcement_id
            AND a.status='active' AND a.starts_at<=? AND a.ends_at>?
        )
      RETURNING acknowledged_at AS acknowledgedAt
    `).bind(now, id, member!.id, deliveryLeaseToken, leaseExpiredBefore, now, now).first<{ acknowledgedAt: string }>();
    if (!acknowledged) {
      return Response.json(
        { error: "알림 전달 권한이 만료되었습니다.", inactive: true },
        { status: 409, headers: { "Cache-Control": "private, no-store" } },
      );
    }
    return Response.json({ ok: true }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    console.error("Acknowledge member system announcement failed", error);
    return Response.json({ error: "알림 확인을 저장하지 못했습니다." }, { status: 500, headers: { "Cache-Control": "private, no-store" } });
  }
}
