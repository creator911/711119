import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { refreshAutomaticMemberLevel } from "../../../../lib/member-level-progress";

const parsePostId = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-2));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function POST(request: Request) {
  const user = await memberFromSession(request);
  if (!user) return Response.json({ error: "로그인 후 댓글을 작성할 수 있습니다." }, { status: 401 });
  const postId = parsePostId(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });

  try {
    const payload = await request.json() as { body?: unknown };
    const body = typeof payload.body === "string" ? payload.body.trim().replace(/\r\n/g, "\n") : "";
    if (body.length < 1 || body.length > 500) return Response.json({ error: "댓글은 1–500자로 입력해 주세요." }, { status: 400 });
    const post = await env.DB.prepare("SELECT id FROM posts WHERE id=? AND status='published'").bind(postId).first();
    if (!post) return Response.json({ error: "게시글을 찾을 수 없습니다." }, { status: 404 });
    const createdAt = new Date().toISOString();
    const inserted = await env.DB.prepare(`
      INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'published',?)
    `).bind(postId, user.id, body, createdAt).run();
    let authorLevel = user.level;
    try {
      authorLevel = await refreshAutomaticMemberLevel(env.DB, user.id);
    } catch (levelError) {
      console.error("Automatic member level refresh failed", levelError);
    }
    return Response.json({ comment: { id: inserted.meta.last_row_id, body, author: user.nickname, authorLevel, createdAt } }, { status: 201 });
  } catch (error) {
    console.error("Comment creation failed", error);
    return Response.json({ error: "댓글을 저장하지 못했습니다." }, { status: 500 });
  }
}
