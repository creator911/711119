import { env } from "cloudflare:workers";
import { isAdminRequest } from "../../../lib/admin-auth";
import {
  ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL,
  adminSupportPrefixSearch,
  adminSupportSearchBindings,
} from "../../../lib/admin-support-search";

const inquiryKindOf = (request: Request) => new URL(request.url).searchParams.get("kind") === "partner" ? "partner" : "support";
const DEFAULT_PAGE_SIZE = 30;
const MAX_PAGE_SIZE = 100;

const positiveInteger = (value: string | null, fallback: number) => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function GET(request: Request) {
  if (!await isAdminRequest(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  const kind = inquiryKindOf(request);
  const url = new URL(request.url);
  const requestedPage = positiveInteger(url.searchParams.get("page"), 1);
  const requestedPageSize = positiveInteger(url.searchParams.get("pageSize"), DEFAULT_PAGE_SIZE);
  const search = adminSupportPrefixSearch(url.searchParams.get("q") ?? "");
  if (requestedPage === null || requestedPageSize === null || requestedPageSize > MAX_PAGE_SIZE || !search) {
    return Response.json({ error: "문의 목록 요청을 확인해 주세요." }, { status: 400 });
  }
  const { query, pattern } = search;
  try {
    const searchBindings = adminSupportSearchBindings(kind, pattern);
    const count = query
      ? await env.DB.prepare(`${ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL}
          SELECT COUNT(*) AS count FROM matched_ids
        `).bind(...searchBindings).first<{ count: number }>()
      : await env.DB.prepare("SELECT COUNT(*) AS count FROM support_inquiries WHERE kind=? AND status != 'deleted'")
        .bind(kind).first<{ count: number }>();
    const total = Math.max(0, Number(count?.count ?? 0));
    const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
    const page = Math.min(requestedPage, totalPages);
    const offset = (page - 1) * requestedPageSize;
    const inquiries = query
      ? await env.DB.prepare(`${ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL},
          page_ids AS (
            SELECT i.id
            FROM matched_ids m
            JOIN support_inquiries i ON i.id=m.id
            ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,i.staff_unread DESC,i.updated_at DESC,i.id DESC
            LIMIT ? OFFSET ?
          )
          SELECT i.id,i.title,i.status,i.staff_unread AS staffUnread,i.member_unread AS memberUnread,
                 i.created_at AS createdAt,i.updated_at AS updatedAt,
                 u.id AS userId,u.username,u.nickname,u.points,
                 COALESCE(s.reply_count,0) AS replyCount
          FROM page_ids p
          JOIN support_inquiries i ON i.id=p.id
          JOIN users u ON u.id=i.user_id
          LEFT JOIN support_stats s ON s.inquiry_id=i.id
          ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,i.staff_unread DESC,i.updated_at DESC,i.id DESC
        `).bind(...searchBindings, requestedPageSize, offset).all()
      : await env.DB.prepare(`
          WITH page_ids AS (
            SELECT id
            FROM support_inquiries
            WHERE kind=? AND status != 'deleted'
            ORDER BY CASE WHEN status='open' THEN 0 ELSE 1 END,staff_unread DESC,updated_at DESC,id DESC
            LIMIT ? OFFSET ?
          )
          SELECT i.id,i.title,i.status,i.staff_unread AS staffUnread,i.member_unread AS memberUnread,
                 i.created_at AS createdAt,i.updated_at AS updatedAt,
                 u.id AS userId,u.username,u.nickname,u.points,
                 COALESCE(s.reply_count,0) AS replyCount
          FROM page_ids p
          JOIN support_inquiries i ON i.id=p.id
          JOIN users u ON u.id=i.user_id
          LEFT JOIN support_stats s ON s.inquiry_id=i.id
          ORDER BY CASE WHEN i.status='open' THEN 0 ELSE 1 END,i.staff_unread DESC,i.updated_at DESC,i.id DESC
        `).bind(kind, requestedPageSize, offset).all();
    return Response.json(
      { inquiries: inquiries.results, total, page, pageSize: requestedPageSize, totalPages, query },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    console.error("Admin support inquiries load failed", error);
    return Response.json({ error: "문의 목록을 불러오지 못했습니다." }, { status: 500 });
  }
}
