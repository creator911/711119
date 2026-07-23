import { env } from "cloudflare:workers";
import { maybePruneExpiredAnnouncementReceipts } from "../../../lib/auth-maintenance";
import { memberFromSession } from "../../../lib/member-auth";
import {
  ANNOUNCEMENT_DELIVERY_LEASE_MS,
  eligibleAnnouncementMember,
  MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS,
  type SystemAnnouncement,
} from "../../../lib/system-announcements";

type CandidateRow = {
  id: number;
  content: string;
  requiresConfirmation: number;
  startsAt: string;
  endsAt: string;
  updatedAt: string;
};
type LeaseWaitRow = { deliveredAt: string };

const asAnnouncement = (row: CandidateRow): SystemAnnouncement => ({
  id: row.id,
  content: row.content,
  requiresConfirmation: Boolean(row.requiresConfirmation),
  startsAt: row.startsAt,
  endsAt: row.endsAt,
  updatedAt: row.updatedAt,
});

export async function GET(request: Request) {
  const member = await memberFromSession(request);
  if (!eligibleAnnouncementMember(member)) {
    return Response.json({ eligible: false, announcement: null }, { headers: { "Cache-Control": "no-store" } });
  }
  const requestNow = new Date();
  await maybePruneExpiredAnnouncementReceipts(env.DB, member!.id, requestNow).catch((error) => {
    console.error("Prune expired system announcement receipts failed", error);
  });
  const searchParams = new URL(request.url).searchParams;
  const rawExclusions = searchParams.get("exclude");
  const rawRequiredOnly = searchParams.get("requiredOnly");
  if (rawRequiredOnly !== null && rawRequiredOnly !== "1") {
    return Response.json({ error: "알림 조회 조건을 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const requiredOnly = rawRequiredOnly === "1";
  const exclusionParts = rawExclusions ? rawExclusions.split(",") : [];
  if (
    (rawExclusions?.length ?? 0) > 256
    || exclusionParts.length > MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS
    || exclusionParts.some((value) => !/^\d+$/.test(value) || Number(value) < 1 || !Number.isSafeInteger(Number(value)))
  ) {
    return Response.json({ error: "제외할 알림 목록을 확인해 주세요." }, { status: 400, headers: { "Cache-Control": "private, no-store" } });
  }
  const excludedIds = [...new Set(exclusionParts.map(Number))];
  const exclusionSql = excludedIds.length
    ? `AND (a.requires_confirmation=1 OR a.id NOT IN (${excludedIds.map(() => "?").join(",")}))`
    : "";
  const requiredOnlySql = requiredOnly ? "AND a.requires_confirmation=1" : "";
  const requiredPrioritySql = excludedIds.length ? "a.requires_confirmation DESC," : "";
  const now = requestNow.toISOString();
  const leaseExpiredBefore = new Date(requestNow.getTime() - ANNOUNCEMENT_DELIVERY_LEASE_MS).toISOString();
  try {
    // Claim selection and receipt mutation are one SQLite statement. The
    // UNIQUE(announcement_id,user_id) conflict guard is what makes concurrent
    // /next calls from multiple tabs resolve to at most one delivery.
    const claim = await env.DB.prepare(`
      INSERT INTO system_announcement_receipts(announcement_id,user_id,delivered_at,acknowledged_at)
      SELECT candidate.id,?, ?,NULL
      FROM (
        SELECT a.id
        FROM system_announcements a
        LEFT JOIN system_announcement_receipts r
          ON r.announcement_id=a.id AND r.user_id=?
        WHERE a.status='active' AND a.starts_at<=? AND a.ends_at>?
          AND r.acknowledged_at IS NULL
          AND (r.id IS NULL OR r.delivered_at<=?)
          ${requiredOnlySql}
          ${exclusionSql}
        ORDER BY ${requiredPrioritySql} a.starts_at ASC,a.id ASC
        LIMIT 1
      ) candidate
      WHERE 1
      ON CONFLICT(announcement_id,user_id) DO UPDATE SET
        delivered_at=excluded.delivered_at
      WHERE system_announcement_receipts.acknowledged_at IS NULL
        AND system_announcement_receipts.delivered_at<=?
      RETURNING announcement_id AS announcementId
    `).bind(
      member!.id,
      now,
      member!.id,
      now,
      now,
      leaseExpiredBefore,
      ...excludedIds,
      leaseExpiredBefore,
    ).first<{ announcementId: number }>();

    const row = claim
      ? await env.DB.prepare(`
          SELECT id,content,requires_confirmation AS requiresConfirmation,
                 starts_at AS startsAt,ends_at AS endsAt,updated_at AS updatedAt
          FROM system_announcements
          WHERE id=? AND status='active' AND starts_at<=? AND ends_at>?
        `).bind(claim.announcementId, now, now).first<CandidateRow>()
      : null;
    const waiting = !claim
      ? await env.DB.prepare(`
          SELECT r.delivered_at AS deliveredAt
          FROM system_announcement_receipts r
          JOIN system_announcements a ON a.id=r.announcement_id
          WHERE r.user_id=? AND r.acknowledged_at IS NULL AND r.delivered_at>?
            AND a.status='active' AND a.starts_at<=? AND a.ends_at>?
          ORDER BY r.delivered_at ASC
          LIMIT 1
        `).bind(member!.id, leaseExpiredBefore, now, now).first<LeaseWaitRow>()
      : null;
    const retryAfterMs = waiting
      ? Math.max(250, Math.min(ANNOUNCEMENT_DELIVERY_LEASE_MS, Date.parse(waiting.deliveredAt) + ANNOUNCEMENT_DELIVERY_LEASE_MS - Date.now() + 100))
      : null;
    return Response.json(
      {
        eligible: true,
        announcement: row ? asAnnouncement(row) : null,
        deliveryLeaseToken: row ? now : null,
        retryAfterMs,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("Load member system announcement failed", error);
    return Response.json({ error: "전체 알림을 불러오지 못했습니다." }, { status: 500 });
  }
}
