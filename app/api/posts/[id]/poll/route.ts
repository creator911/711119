import { env } from "cloudflare:workers";
import { memberFromSession } from "../../../../lib/member-auth";
import { loadPostPoll } from "../../../../lib/post-poll-results";

const postIdOf = (request: Request) => {
  const segments = new URL(request.url).pathname.split("/").filter(Boolean);
  const id = Number(segments.at(-2));
  return Number.isInteger(id) && id > 0 ? id : null;
};

export async function POST(request: Request) {
  const postId = postIdOf(request);
  if (!postId) return Response.json({ error: "게시글 번호를 확인해 주세요." }, { status: 400 });
  const member = await memberFromSession(request);
  if (!member) return Response.json({ error: "로그인 후 투표할 수 있습니다." }, { status: 401 });
  try {
    const payload = await request.json() as { optionId?: unknown };
    const optionId = Number(payload.optionId);
    if (!Number.isInteger(optionId) || optionId < 1) return Response.json({ error: "투표 선택지를 확인해 주세요." }, { status: 400 });
    const option = await env.DB.prepare(`
      SELECT o.id,poll.id AS pollId
      FROM post_poll_options o
      JOIN post_polls poll ON poll.id=o.poll_id
      JOIN posts post ON post.id=poll.post_id
      WHERE post.id=? AND post.status='published' AND o.id=?
    `).bind(postId, optionId).first<{ id: number; pollId: number }>();
    if (!option) return Response.json({ error: "투표 또는 선택지를 찾을 수 없습니다." }, { status: 404 });
    const existing = await env.DB.prepare("SELECT id FROM post_poll_votes WHERE poll_id=? AND user_id=?").bind(option.pollId, member.id).first();
    if (existing) return Response.json({ error: "이 투표에는 이미 참여했습니다." }, { status: 409 });
    await env.DB.prepare("INSERT INTO post_poll_votes(poll_id,option_id,user_id,created_at) VALUES(?,?,?,?)")
      .bind(option.pollId, option.id, member.id, new Date().toISOString()).run();
    return Response.json({ poll: await loadPostPoll(env.DB, postId, member.id) });
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return Response.json({ error: "이 투표에는 이미 참여했습니다." }, { status: 409 });
    }
    console.error("Post poll vote failed", error);
    return Response.json({ error: "투표를 처리하지 못했습니다." }, { status: 500 });
  }
}
