import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";

export async function GET(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  try {
    const posts = await env.DB.prepare(`
      SELECT p.id,p.category,p.title,p.body,p.views,p.likes,p.dislikes,p.report_count AS reportCount,p.is_notice AS isNotice,p.is_pinned AS isPinned,p.created_at AS createdAt,
             COALESCE(u.nickname,'탈퇴회원') AS author,
             COALESCE(u.level,0) AS authorLevel,
             (SELECT COUNT(*) FROM post_comments c WHERE c.post_id=p.id AND c.status='published') AS commentCount
      FROM posts p LEFT JOIN users u ON u.id = p.author_id
      WHERE p.author_id = ? AND p.status = 'published'
      ORDER BY p.id DESC LIMIT 100
    `).bind(user.id).all();

    const pointHistory = await env.DB.prepare(`
      SELECT id,amount,type,status,reference,created_at AS createdAt
      FROM point_ledger
      WHERE user_id = ?
      ORDER BY id DESC LIMIT 100
    `).bind(user.id).all();

    return Response.json({
      user: { username: user.username, nickname: user.nickname, points: user.points, level: user.level },
      posts: posts.results,
      pointHistory: pointHistory.results,
    });
  } catch (error) {
    console.error("My page load failed", error);
    return Response.json({ error: "마이페이지 정보를 불러오지 못했습니다." }, { status: 500 });
  }
}
