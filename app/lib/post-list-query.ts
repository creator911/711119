export type PostListCategory = "notices" | "reviews" | "events" | "gifs" | "community";
export type PostListSort = "latest" | "popular";

const POPULAR_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function buildPostListQuery(category: PostListCategory, sort: PostListSort, now = new Date()) {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) throw new TypeError("now must be a valid Date");

  const categoryWhere = category === "community"
    ? "p.category IN ('community','gifs') AND p.is_notice=0"
    : category === "notices"
      ? "p.category='notices'"
      : "p.category=? AND p.is_notice=0";
  const popularWhere = sort === "popular" ? " AND p.created_at >= ? AND p.created_at <= ?" : "";
  const orderBy = sort === "popular"
    ? "(p.likes-p.dislikes) DESC,p.views DESC,p.created_at DESC,p.id DESC"
    : "p.is_pinned DESC,p.is_notice DESC,p.id DESC";
  const bindings: Array<string> = category === "community" || category === "notices" ? [] : [category];
  if (sort === "popular") bindings.push(new Date(nowMs - POPULAR_WINDOW_MS).toISOString(), now.toISOString());

  return {
    bindings,
    sql: `
      SELECT p.id,p.category,p.title,p.body,p.views,p.likes,p.dislikes,p.report_count AS reportCount,p.is_notice AS isNotice,p.is_pinned AS isPinned,p.community_tag_mask AS communityTagMask,p.created_at AS createdAt,
             CASE WHEN u.nickname IS NULL THEN '운영자' ELSE u.nickname END AS author,
             COALESCE(u.level,0) AS authorLevel,
             (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id AND c.status='published') AS commentCount
      FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE ${categoryWhere} AND p.status = 'published'${popularWhere}
      ORDER BY ${orderBy} LIMIT 100
    `,
  };
}
