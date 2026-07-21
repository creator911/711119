import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { memberFromSession, type MemberSession } from "../../../lib/member-auth";
import { normalizeRichBody } from "../../../lib/rich-text";
import {
  bodyMediaFinalizeStatements,
  mediaLifecycleErrorStatus,
  reserveBodyMedia,
  rollbackBodyMedia,
  bodyMediaReleaseStatements,
  type MediaAttachmentClaim,
} from "../../../lib/media-lifecycle";
import { mediaActorKey } from "../../../lib/media-actor";
import { isVendorCategory, isVendorRegion } from "../../../lib/vendor-regions";

type StoredVendorPost = {
  id: number;
  industry: string;
  region: string;
  district: string;
  title: string;
  body: string;
  authorId: number;
  author: string;
  authorLevel: number;
  createdAt: string;
  updatedAt: string;
};

const parseId = (request: Request) => {
  const id = Number(new URL(request.url).pathname.split("/").filter(Boolean).at(-1));
  return Number.isInteger(id) && id > 0 ? id : null;
};
const canManage = (viewer: MemberSession | null, post: Pick<StoredVendorPost, "authorId">, adminActor = false) =>
  adminActor || Boolean(viewer && (viewer.level === 10 || viewer.id === post.authorId));
const decorate = (post: StoredVendorPost, viewer: MemberSession | null, adminActor = false) => ({
  id: post.id,
  industry: post.industry,
  region: post.region,
  district: post.district,
  title: post.title,
  body: post.body,
  author: post.author,
  authorLevel: post.authorLevel,
  createdAt: post.createdAt,
  updatedAt: post.updatedAt,
  isOwn: Boolean(viewer && viewer.id === post.authorId),
  canEdit: canManage(viewer, post, adminActor),
  canDelete: canManage(viewer, post, adminActor),
});

async function loadPost(id: number) {
  return env.DB.prepare(`
    SELECT vp.id,vp.industry,vp.region,vp.district,vp.title,vp.body,vp.author_id AS authorId,
           COALESCE(u.nickname,'탈퇴회원') AS author,COALESCE(u.level,0) AS authorLevel,
           vp.created_at AS createdAt,vp.updated_at AS updatedAt
    FROM vendor_posts vp LEFT JOIN users u ON u.id=vp.author_id
    WHERE vp.id=? AND vp.status='published'
  `).bind(id).first<StoredVendorPost>();
}

export async function GET(request: Request) {
  const id = parseId(request);
  if (!id) return Response.json({ error: "업체정보 글 번호를 확인해 주세요." }, { status: 400 });
  try {
    const [post, viewer, operator] = await Promise.all([loadPost(id), memberFromSession(request), adminSession(request, env)]);
    if (!post) return Response.json({ error: "업체정보 글을 찾을 수 없습니다." }, { status: 404 });
    return Response.json({ post: decorate(post, viewer, Boolean(operator)) });
  } catch (error) {
    console.error("Vendor post detail load failed", error);
    return Response.json({ error: "업체정보 글을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const id = parseId(request);
  if (!id) return Response.json({ error: "업체정보 글 번호를 확인해 주세요." }, { status: 400 });
  const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
  if (!viewer && !operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const adminActor = Boolean(operator);
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;
  try {
    const post = await loadPost(id);
    if (!post) return Response.json({ error: "업체정보 글을 찾을 수 없습니다." }, { status: 404 });
    if (!canManage(viewer, post, adminActor)) return Response.json({ error: "업체정보 글을 수정할 권한이 없습니다." }, { status: 403 });
    const payload = await request.json() as { industry?: unknown; region?: unknown; district?: unknown; title?: unknown; body?: unknown };
    const industry = typeof payload.industry === "string" ? payload.industry.trim() : "";
    const region = typeof payload.region === "string" ? payload.region.trim() : "";
    const district = typeof payload.district === "string" ? payload.district.trim() : "";
    const title = typeof payload.title === "string" ? payload.title.trim().replace(/\s+/g, " ") : "";
    const sourceBody = typeof payload.body === "string" ? payload.body : "";
    if (!isVendorCategory(industry)) return Response.json({ error: "업종을 하나만 선택해 주세요." }, { status: 400 });
    if (!isVendorRegion(region, district)) return Response.json({ error: "상세지역을 하나만 선택해 주세요." }, { status: 400 });

    if (region !== post.region || district !== post.district) return Response.json({ error: "등록한 업체정보의 상세지역은 변경할 수 없습니다." }, { status: 409 });

    const { body, textLength } = normalizeRichBody(sourceBody);
    const hasMedia = /<(?:img|video|iframe)\b/i.test(body);
    if (/post-poll-slot/i.test(body)) return Response.json({ error: "업체정보 글에는 투표를 넣을 수 없습니다." }, { status: 400 });
    if (title.length < 2 || title.length > 80) return Response.json({ error: "제목은 2~80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2~3,000자로 입력해 주세요." }, { status: 400 });
    const actorKey = await mediaActorKey(request, env);
    if (!actorKey) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    mediaClaim = await reserveBodyMedia(env.DB, actorKey, body, post.body);
    const updatedAt = new Date().toISOString();
    const updateStatement = env.DB.prepare(`
      UPDATE vendor_posts SET industry=?,region=?,district=?,title=?,body=?,updated_at=?
      WHERE id=? AND status='published' AND (
        ?=1 OR EXISTS(
          SELECT 1 FROM users
          WHERE id=? AND status='active'
            AND (vendor_posts.author_id=users.id OR users.level=10)
        )
      )
    `).bind(industry, region, district, title, body, updatedAt, id, adminActor ? 1 : 0, viewer?.id ?? -1);
    const results = await env.DB.batch([
      updateStatement,
      ...bodyMediaFinalizeStatements(env.DB, mediaClaim, "vendor", id, body, updatedAt),
    ]);
    const updated = results[0];
    if (!updated.meta.changes) {
      await rollbackBodyMedia(env.DB, mediaClaim);
      mediaClaim = null;
      return Response.json({ error: "업체정보 글을 수정할 권한이 없습니다." }, { status: 403 });
    }
    saveCommitted = true;
    const next = await loadPost(id);
    return Response.json({ post: next ? decorate(next, viewer, adminActor) : null });
  } catch (error) {
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "해당 상세지역에는 이미 업체정보 글을 등록했습니다." }, { status: 409 });
    console.error("Vendor post update failed", error);
    return Response.json({ error: "업체정보 글을 수정하지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const id = parseId(request);
  if (!id) return Response.json({ error: "업체정보 글 번호를 확인해 주세요." }, { status: 400 });
  const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
  if (!viewer && !operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const adminActor = Boolean(operator);
  try {
    const post = await loadPost(id);
    if (!post) return Response.json({ error: "업체정보 글을 찾을 수 없습니다." }, { status: 404 });
    if (!canManage(viewer, post, adminActor)) return Response.json({ error: "업체정보 글을 삭제할 권한이 없습니다." }, { status: 403 });
    const deleteStatement = env.DB.prepare(`
      DELETE FROM vendor_posts
      WHERE id=? AND (
        ?=1 OR EXISTS(
          SELECT 1 FROM users
          WHERE id=? AND status='active'
            AND (vendor_posts.author_id=users.id OR users.level=10)
        )
      )
    `).bind(id, adminActor ? 1 : 0, viewer?.id ?? -1);
    const cleanupStatements = await bodyMediaReleaseStatements(env.DB, "vendor", id);
    const results = await env.DB.batch([deleteStatement, ...cleanupStatements]);
    const deleted = results[0];
    if (!deleted.meta.changes) return Response.json({ error: "업체정보 글을 삭제할 권한이 없습니다." }, { status: 403 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Vendor post deletion failed", error);
    return Response.json({ error: "업체정보 글을 삭제하지 못했습니다." }, { status: 500 });
  }
}
