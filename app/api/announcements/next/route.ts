import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../lib/member-auth";
import { eligibleAnnouncementMember, type SystemAnnouncement } from "../../../lib/system-announcements";

type CandidateRow = {
  id: number;
  content: string;
  requiresConfirmation: number;
  startsAt: string;
  endsAt: string;
  receiptId: number | null;
};

const asAnnouncement = (row: CandidateRow): SystemAnnouncement => ({
  id: row.id,
  content: row.content,
  requiresConfirmation: Boolean(row.requiresConfirmation),
  startsAt: row.startsAt,
  endsAt: row.endsAt,
});

export async function GET(request: Request) {
  const member = await memberFromSession(request);
  if (!eligibleAnnouncementMember(member)) {
    return Response.json({ eligible: false, announcement: null }, { headers: { "Cache-Control": "no-store" } });
  }
  const now = new Date().toISOString();
  try {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const row = await env.DB.prepare(`
        SELECT a.id,a.content,a.requires_confirmation AS requiresConfirmation,
               a.starts_at AS startsAt,a.ends_at AS endsAt,r.id AS receiptId
        FROM system_announcements a
        LEFT JOIN system_announcement_receipts r
          ON r.announcement_id=a.id AND r.user_id=?
        WHERE a.status='active' AND a.starts_at<=? AND a.ends_at>?
          AND (r.id IS NULL OR (a.requires_confirmation=1 AND r.acknowledged_at IS NULL))
        ORDER BY a.starts_at ASC,a.id ASC
        LIMIT 1
      `).bind(member!.id, now, now).first<CandidateRow>();
      if (!row) return Response.json({ eligible: true, announcement: null }, { headers: { "Cache-Control": "no-store" } });

      if (row.requiresConfirmation) {
        if (!row.receiptId) {
          await env.DB.prepare(`
            INSERT OR IGNORE INTO system_announcement_receipts(announcement_id,user_id,delivered_at,acknowledged_at)
            VALUES(?,?,?,NULL)
          `).bind(row.id, member!.id, now).run();
        }
        return Response.json({ eligible: true, announcement: asAnnouncement(row) }, { headers: { "Cache-Control": "no-store" } });
      }

      const claim = await env.DB.prepare(`
        INSERT OR IGNORE INTO system_announcement_receipts(announcement_id,user_id,delivered_at,acknowledged_at)
        VALUES(?,?,?,?)
      `).bind(row.id, member!.id, now, now).run();
      if (Number(claim.meta.changes) > 0) {
        return Response.json({ eligible: true, announcement: asAnnouncement(row) }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    return Response.json({ eligible: true, announcement: null }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Load member system announcement failed", error);
    return Response.json({ error: "전체 알림을 불러오지 못했습니다." }, { status: 500 });
  }
}
