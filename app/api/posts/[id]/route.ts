import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { memberFromSession, type MemberSession } from "../../../lib/member-auth";
import { loadPostPoll } from "../../../lib/post-poll-results";
import { PollValidationError, preparePostBody } from "../../../lib/post-polls";
import { hasRichMedia, normalizeRichTitle } from "../../../lib/rich-text";
import {
  bodyMediaFinalizeStatements,
  mediaLifecycleErrorStatus,
  reserveBodyMedia,
  rollbackBodyMedia,
  bodyMediaReleaseStatements,
  type MediaAttachmentClaim,
} from "../../../lib/media-lifecycle";
import { mediaActorKey } from "../../../lib/media-actor";
import { communityTagsFromMask, isCommunityBoardCategory, validateCommunityTags } from "../../../lib/community-tags";
import { normalizeTitleColor } from "../../../lib/title-colors";

const parsePostId = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-1));
  return Number.isInteger(id) && id > 0 ? id : null;
};

type StoredPost = {
  id: number;
  authorId: number;
  category: string;
  title: string;
  titleColor: string;
  body: string;
  isPinned: number;
  communityTagMask: number;
};

const canManagePost = (viewer: MemberSession | null, post: Pick<StoredPost, "authorId">, adminActor = false) =>
  adminActor || Boolean(viewer && (viewer.level === 10 || viewer.id === post.authorId));
const isStandaloneAdminActor = (viewer: MemberSession | null, operator: unknown) => !viewer && Boolean(operator);

async function publicPost(id: number, viewer: MemberSession | null, adminActor = false) {
  const post = await env.DB.prepare(`
    SELECT p.id,p.category,p.title,p.title_color AS titleColor,p.body,p.author_id AS authorId,p.views,p.likes,p.dislikes,p.report_count AS reportCount,p.is_notice AS isNotice,p.is_pinned AS isPinned,p.community_tag_mask AS communityTagMask,p.created_at AS createdAt,
           COALESCE(NULLIF(p.author_name,''),u.nickname,'운영자') AS author,
           COALESCE(u.level,0) AS authorLevel,
           (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id AND c.status='published') AS commentCount
    FROM posts p LEFT JOIN users u ON u.id=p.author_id
    WHERE p.id=? AND p.status='published'
  `).bind(id).first<Record<string, unknown> & { authorId: number }>();
  if (!post) return null;
  const isOwn = Boolean(viewer && viewer.id === post.authorId);
  const canManage = canManagePost(viewer, post, adminActor);
  const canPin = adminActor || viewer?.level === 10;
  const { communityTagMask, ...safePost } = post;
  return { ...safePost, communityTags: communityTagsFromMask(communityTagMask, post.category), isOwn, canEdit: canManage, canDelete: canManage, canPin };
}

export async function GET(request: Request) {
  const id = parsePostId(request);
  if (!id) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });

  try {
    const exists = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND status='published'").bind(id).first();
    if (!exists) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });

    await env.DB.prepare("UPDATE posts SET views=views+1 WHERE id=?").bind(id).run();
    const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
    const adminActor = isStandaloneAdminActor(viewer, operator);
    const [post, comments, poll] = await Promise.all([
      publicPost(id, viewer, adminActor),
      env.DB.prepare(`
        SELECT c.id,c.body,c.created_at AS createdAt,COALESCE(u.nickname,'탈퇴회원') AS author,COALESCE(u.level,0) AS authorLevel
        FROM post_comments c LEFT JOIN users u ON u.id=c.user_id
        WHERE c.post_id=? AND c.status='published'
        ORDER BY c.id ASC
      `).bind(id).all(),
      loadPostPoll(env.DB, id, viewer?.id),
    ]);
    return Response.json({ post, comments: comments.results, poll });
  } catch (error) {
    console.error("Post detail load failed", error);
    return Response.json({ error: "게시글을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request) {
  const id = parsePostId(request);
  if (!id) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
  if (!viewer && !operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const adminActor = isStandaloneAdminActor(viewer, operator);
  let mediaClaim: MediaAttachmentClaim | null = null;
  let saveCommitted = false;

  try {
    const post = await env.DB.prepare(
      "SELECT id,author_id AS authorId,category,title,title_color AS titleColor,body,is_pinned AS isPinned,community_tag_mask AS communityTagMask FROM posts WHERE id=? AND status='published'",
    ).bind(id).first<StoredPost>();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    if (!canManagePost(viewer, post, adminActor)) return Response.json({ error: "게시글을 수정할 권한이 없습니다." }, { status: 403 });

    const payload = await request.json() as { title?: unknown; titleColor?: unknown; body?: unknown; isPinned?: unknown; communityTags?: unknown };
    const { title, textLength: titleLength } = normalizeRichTitle(typeof payload.title === "string" ? payload.title : "");
    const titleColor = Object.prototype.hasOwnProperty.call(payload, "titleColor")
      ? normalizeTitleColor(payload.titleColor)
      : post.titleColor;
    const sourceBody = typeof payload.body === "string" ? payload.body : "";
    const { body, textLength, poll } = preparePostBody(sourceBody);
    const hasMedia = hasRichMedia(body);
    let nextCommunityTagMask = isCommunityBoardCategory(post.category) ? (post.communityTagMask || 4) : 0;
    if (isCommunityBoardCategory(post.category)) {
      if (Object.prototype.hasOwnProperty.call(payload, "communityTags")) {
        const validated = validateCommunityTags(payload.communityTags);
        if (!validated.ok) return Response.json({ error: validated.error }, { status: 400 });
        nextCommunityTagMask = validated.mask;
      }
    } else if (payload.communityTags !== undefined && (!Array.isArray(payload.communityTags) || payload.communityTags.length > 0)) {
      return Response.json({ error: "머릿글은 커뮤니티 글에만 사용할 수 있습니다." }, { status: 400 });
    }
    if (titleColor === null) return Response.json({ error: "제목 색상을 확인해 주세요." }, { status: 400 });
    if (titleLength < 2 || titleLength > 80) return Response.json({ error: "제목은 2~80자로 입력해 주세요." }, { status: 400 });
    if ((textLength < 2 && !hasMedia && !poll) || textLength > 3000 || body.length > 20000) {
      return Response.json({ error: "내용은 2~3,000자로 입력해 주세요." }, { status: 400 });
    }

    const existingPoll = await env.DB.prepare("SELECT id FROM post_polls WHERE post_id=?").bind(id).first<{ id: number }>();
    if (poll) return Response.json({ error: "게시글 수정 중에는 투표를 새로 추가하거나 변경할 수 없습니다." }, { status: 409 });
    if (!existingPoll && /post-poll-slot/i.test(body)) return Response.json({ error: "올바르지 않은 투표 정보입니다." }, { status: 400 });

    const actorKey = await mediaActorKey(request, env);
    if (!actorKey) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    mediaClaim = await reserveBodyMedia(env.DB, actorKey, body, post.body);

    const nextPinned = (adminActor || viewer?.level === 10) && (post.category === "community" || post.category === "reviews")
      ? payload.isPinned === true ? 1 : 0
      : post.isPinned;
    const keepsExistingPoll = Boolean(existingPoll && new RegExp(`data-poll-id=["']${existingPoll.id}["']`, "i").test(body));
    const statements = [];
    if (existingPoll && !keepsExistingPoll) {
      statements.push(
        env.DB.prepare(`DELETE FROM post_poll_votes WHERE poll_id=? AND EXISTS(
          SELECT 1 FROM post_polls pp JOIN posts p ON p.id=pp.post_id
          WHERE pp.id=? AND p.id=? AND p.status='published' AND (?=1 OR p.author_id=? OR ?=10)
        )`).bind(existingPoll.id, existingPoll.id, id, adminActor ? 1 : 0, viewer?.id ?? -1, viewer?.level ?? 0),
        env.DB.prepare(`DELETE FROM post_poll_options WHERE poll_id=? AND EXISTS(
          SELECT 1 FROM post_polls pp JOIN posts p ON p.id=pp.post_id
          WHERE pp.id=? AND p.id=? AND p.status='published' AND (?=1 OR p.author_id=? OR ?=10)
        )`).bind(existingPoll.id, existingPoll.id, id, adminActor ? 1 : 0, viewer?.id ?? -1, viewer?.level ?? 0),
        env.DB.prepare(`DELETE FROM post_polls WHERE id=? AND post_id=? AND EXISTS(
          SELECT 1 FROM posts p WHERE p.id=? AND p.status='published' AND (?=1 OR p.author_id=? OR ?=10)
        )`).bind(existingPoll.id, id, id, adminActor ? 1 : 0, viewer?.id ?? -1, viewer?.level ?? 0),
      );
    }
    const updateStatementIndex = statements.length;
    statements.push(env.DB.prepare(
      "UPDATE posts SET title=?,title_color=?,body=?,is_pinned=?,community_tag_mask=? WHERE id=? AND status='published' AND (?=1 OR author_id=? OR ?=10)",
    ).bind(title, titleColor, body, nextPinned, nextCommunityTagMask, id, adminActor ? 1 : 0, viewer?.id ?? -1, viewer?.level ?? 0));
    statements.push(...bodyMediaFinalizeStatements(env.DB, mediaClaim, "post", id, body));
    const results = await env.DB.batch(statements);
    if (!results[updateStatementIndex]?.meta.changes) {
      await rollbackBodyMedia(env.DB, mediaClaim);
      mediaClaim = null;
      return Response.json({ error: "게시글을 수정할 권한이 없습니다." }, { status: 403 });
    }
    saveCommitted = true;

    const updated = await publicPost(id, viewer, adminActor);
    return Response.json({ post: updated });
  } catch (error) {
    if (mediaClaim && !saveCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    if (error instanceof PollValidationError) return Response.json({ error: error.message }, { status: 400 });
    console.error("Post update failed", error);
    return Response.json({ error: "게시글을 수정하지 못했습니다." }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const id = parsePostId(request);
  if (!id) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const [viewer, operator] = await Promise.all([memberFromSession(request), adminSession(request, env)]);
  if (!viewer && !operator) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
  const adminActor = isStandaloneAdminActor(viewer, operator);

  try {
    const post = await env.DB.prepare("SELECT id,author_id AS authorId FROM posts WHERE id=? AND status='published'")
      .bind(id).first<Pick<StoredPost, "id" | "authorId">>();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    if (!canManagePost(viewer, post, adminActor)) return Response.json({ error: "게시글을 삭제할 권한이 없습니다." }, { status: 403 });

    const deleteStatement = env.DB.prepare(
      "UPDATE posts SET status='deleted' WHERE id=? AND status='published' AND (?=1 OR author_id=? OR ?=10)",
    ).bind(id, adminActor ? 1 : 0, viewer?.id ?? -1, viewer?.level ?? 0);
    const cleanupStatements = await bodyMediaReleaseStatements(env.DB, "post", id);
    const results = await env.DB.batch([deleteStatement, ...cleanupStatements]);
    const deleted = results[0];
    if (!deleted.meta.changes) return Response.json({ error: "게시글을 삭제할 권한이 없습니다." }, { status: 403 });
    return Response.json({ ok: true });
  } catch (error) {
    console.error("Post deletion failed", error);
    return Response.json({ error: "게시글을 삭제하지 못했습니다." }, { status: 500 });
  }
}
