export type PostListCategory = "notices" | "reviews" | "events" | "gifs" | "community";
export type PostListSort = "latest" | "popular";

const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function buildPostListQuery(
  category: PostListCategory,
  sort: PostListSort,
  now = new Date(),
  options: { limit?: number; beforeId?: number | null } = {},
) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date");
  const limit = Math.max(1, Math.min(100, Number.isInteger(options.limit) ? Number(options.limit) : 100));
  const beforeId = sort === "latest" && Number.isInteger(options.beforeId) && Number(options.beforeId) > 0
    ? Number(options.beforeId)
    : null;

  const categoryWhere = category === "community"
    ? "p.category IN ('community','gifs') AND p.is_notice=0"
    : category === "notices"
      ? "p.category='notices'"
      : "p.category=? AND p.is_notice=0";
  const popularWhere = sort === "popular" ? " AND p.created_at >= ? AND p.created_at <= ?" : "";
  const cursorWhere = beforeId ? " AND p.id < ?" : "";
  const orderBy = sort === "popular"
    ? "(p.likes-p.dislikes) DESC,p.views DESC,p.created_at DESC,p.id DESC"
    : "p.is_pinned DESC,p.is_notice DESC,p.id DESC";
  const bindings: Array<string> = category === "community" || category === "notices" ? [] : [category];
  if (sort === "popular") bindings.push(new Date(nowMs - POPULAR_WINDOW_MS).toISOString(), now.toISOString());
  if (beforeId) bindings.push(String(beforeId));

  return {
    bindings,
    sql: `
      SELECT p.id,p.category,p.title,p.title_color AS titleColor,'' AS body,
             p.views,p.likes,p.dislikes,p.report_count AS reportCount,
             p.is_notice AS isNotice,p.is_pinned AS isPinned,
             p.community_tag_mask AS communityTagMask,p.created_at AS createdAt,
             COALESCE(NULLIF(p.author_name,''),u.nickname,'운영자') AS author,
             COALESCE(u.level,0) AS authorLevel,
             COALESCE(ps.comment_count,0) AS commentCount
      FROM posts p
      LEFT JOIN users u ON u.id=p.author_id
      LEFT JOIN post_stats ps ON ps.post_id=p.id
      WHERE ${categoryWhere} AND p.status='published'${popularWhere}${cursorWhere}
      ORDER BY ${orderBy}
      LIMIT ${limit}
    `,
  };
}
