import { env } from "cloudflare:workers";
import { activeAnnouncementSnapshot } from "../../../lib/system-announcement-active-cache";
import {
  ANNOUNCEMENT_ACTIVE_CACHE_SECONDS,
  type ActiveSystemAnnouncement,
} from "../../../lib/system-announcements";

type ActiveRow = ActiveSystemAnnouncement;

const cacheHeaders = (etag: string) => ({
  "Cache-Control": `public, max-age=2, s-maxage=${ANNOUNCEMENT_ACTIVE_CACHE_SECONDS}, must-revalidate`,
  "CDN-Cache-Control": `public, max-age=${ANNOUNCEMENT_ACTIVE_CACHE_SECONDS}, must-revalidate`,
  ETag: etag,
});

async function versionOf(rows: ActiveRow[]) {
  const source = JSON.stringify(rows.map((row) => [row.id, row.endsAt, row.updatedAt]));
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return `"ann-${Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}

async function refreshSnapshot() {
  return activeAnnouncementSnapshot(async () => {
    const now = new Date().toISOString();
    const result = await env.DB.prepare(`
      SELECT id,ends_at AS endsAt,updated_at AS updatedAt
      FROM system_announcements
      WHERE status='active' AND starts_at<=? AND ends_at>?
      ORDER BY starts_at ASC,id ASC
    `).bind(now, now).all<ActiveRow>();
    const announcements = result.results;
    return { announcements, etag: await versionOf(announcements) };
  }, ANNOUNCEMENT_ACTIVE_CACHE_SECONDS * 1_000);
}

export async function GET(request: Request) {
  try {
    const snapshot = await refreshSnapshot();
    const headers = cacheHeaders(snapshot.etag);
    if (request.headers.get("If-None-Match") === snapshot.etag) return new Response(null, { status: 304, headers });
    return Response.json({ announcements: snapshot.announcements }, { headers });
  } catch (error) {
    console.error("Load shared active system announcements failed", error);
    return Response.json(
      { error: "전체 알림 상태를 불러오지 못했습니다." },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
