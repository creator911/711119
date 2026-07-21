import { env } from "cloudflare:workers";
import { bodyMediaReleaseStatements } from "./media-lifecycle";

type ModerationCounts = {
  likes: number;
  dislikes: number;
  reportCount: number;
  isNotice: number;
};

export async function autoDeletePostIfNeeded(postId: number) {
  const counts = await env.DB.prepare(`
    SELECT likes,dislikes,report_count AS reportCount,is_notice AS isNotice
    FROM posts WHERE id=? AND status='published'
  `).bind(postId).first<ModerationCounts>();
  if (!counts || counts.isNotice || counts.reportCount < 1) return false;
  const score = 1 + (counts.likes - counts.dislikes) / counts.reportCount;
  if (score > 0.5) return false;
  const deleteStatement = env.DB.prepare("UPDATE posts SET status='auto_deleted' WHERE id=? AND status='published'").bind(postId);
  const cleanupStatements = await bodyMediaReleaseStatements(env.DB, "post", postId);
  const results = await env.DB.batch([deleteStatement, ...cleanupStatements]);
  const deleted = results[0];
  if (!deleted.meta.changes) return false;
  return true;
}
