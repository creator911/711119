import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { invalidateActiveAnnouncementSnapshot } from "../../../lib/system-announcement-active-cache";
import {
  announcementState,
  MAX_ANNOUNCEMENT_CONTENT,
  normalizeAnnouncementContent,
  parseAnnouncementWindow,
  type AdminSystemAnnouncement,
} from "../../../lib/system-announcements";

type AnnouncementRow = {
  id: number;
  content: string;
  requiresConfirmation: number;
  startsAt: string;
  endsAt: string;
  status: "active" | "cancelled";
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  acknowledgedCount: number;
};

const publicRow = (row: AnnouncementRow): AdminSystemAnnouncement => ({
  ...row,
  requiresConfirmation: Boolean(row.requiresConfirmation),
  state: announcementState(row.status, row.startsAt, row.endsAt),
  acknowledgedCount: Number(row.acknowledgedCount),
});

export async function GET(request: Request) {
  if (!await adminSession(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const result = await env.DB.prepare(`
      WITH recent AS (
        SELECT id,content,requires_confirmation,starts_at,ends_at,status,created_by,created_at,updated_at
        FROM system_announcements ORDER BY id DESC LIMIT 100
      )
      SELECT a.id,a.content,a.requires_confirmation AS requiresConfirmation,
             a.starts_at AS startsAt,a.ends_at AS endsAt,a.status,
             a.created_by AS createdBy,a.created_at AS createdAt,a.updated_at AS updatedAt,
             (SELECT COUNT(*) FROM system_announcement_receipts r
              WHERE r.announcement_id=a.id AND r.acknowledged_at IS NOT NULL) AS acknowledgedCount
      FROM recent a ORDER BY a.id DESC
    `).all<AnnouncementRow>();
    return Response.json({ announcements: result.results.map(publicRow) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Load system announcements failed", error);
    return Response.json({ error: "전체 알림 공지를 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const payload = await request.json() as Record<string, unknown>;
    const content = normalizeAnnouncementContent(payload.content);
    if (!content) return Response.json({ error: "알림 내용을 입력해 주세요." }, { status: 400 });
    if (content.length > MAX_ANNOUNCEMENT_CONTENT) return Response.json({ error: `알림 내용은 ${MAX_ANNOUNCEMENT_CONTENT.toLocaleString()}자 이하로 입력해 주세요.` }, { status: 400 });
    const { startsAt, endsAt } = parseAnnouncementWindow(payload.startsAt, payload.endsAt);
    const requiresConfirmation = payload.requiresConfirmation === true;
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO system_announcements(content,requires_confirmation,starts_at,ends_at,status,created_by,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?)
    `).bind(content, requiresConfirmation ? 1 : 0, startsAt, endsAt, "active", operator.username, createdAt, createdAt).run();
    invalidateActiveAnnouncementSnapshot();
    const id = Number(inserted.meta.last_row_id);
    const row = await env.DB.prepare(`
      SELECT id,content,requires_confirmation AS requiresConfirmation,starts_at AS startsAt,ends_at AS endsAt,
             status,created_by AS createdBy,created_at AS createdAt,updated_at AS updatedAt,
             0 AS acknowledgedCount
      FROM system_announcements WHERE id=?
    `).bind(id).first<AnnouncementRow>();
    return Response.json({ announcement: row ? publicRow(row) : null }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "전체 알림 공지를 등록하지 못했습니다.";
    const known = message.includes("입력") || message.includes("기간") || message.includes("종료");
    if (!known) console.error("Create system announcement failed", error);
    return Response.json({ error: known ? message : "전체 알림 공지를 등록하지 못했습니다." }, { status: known ? 400 : 500 });
  }
}
