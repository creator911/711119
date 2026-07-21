import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { eligibleAnnouncementMember } from "../../../../lib/system-announcements";

type AckRow = { id: number; status: string; startsAt: string; endsAt: string; receiptId: number | null };

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const member = await memberFromSession(request);
  if (!eligibleAnnouncementMember(member)) return Response.json({ error: "알림 확인 대상 회원이 아닙니다." }, { status: 403 });
  const id = Number((await context.params).id);
  if (!Number.isInteger(id) || id <= 0) return Response.json({ error: "올바른 알림 번호가 아닙니다." }, { status: 400 });
  const now = new Date().toISOString();
  try {
    const announcement = await env.DB.prepare(`
      SELECT a.id,a.status,a.starts_at AS startsAt,a.ends_at AS endsAt,r.id AS receiptId
      FROM system_announcements a
      LEFT JOIN system_announcement_receipts r ON r.announcement_id=a.id AND r.user_id=?
      WHERE a.id=?
    `).bind(member!.id, id).first<AckRow>();
    if (!announcement) return Response.json({ error: "알림을 찾지 못했습니다." }, { status: 404 });
    const activeNow = announcement.status === "active" && announcement.startsAt <= now && announcement.endsAt > now;
    if (!announcement.receiptId && !activeNow) return Response.json({ error: "현재 확인할 수 없는 알림입니다." }, { status: 409 });
    await env.DB.prepare(`
      INSERT INTO system_announcement_receipts(announcement_id,user_id,delivered_at,acknowledged_at)
      VALUES(?,?,?,?)
      ON CONFLICT(announcement_id,user_id) DO UPDATE SET acknowledged_at=COALESCE(system_announcement_receipts.acknowledged_at,excluded.acknowledged_at)
    `).bind(id, member!.id, now, now).run();
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Acknowledge member system announcement failed", error);
    return Response.json({ error: "알림 확인을 저장하지 못했습니다." }, { status: 500 });
  }
}
