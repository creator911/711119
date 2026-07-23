const DAY_MS = 24 * 60 * 60 * 1_000;

export async function pruneMediaRetention(database, bucket, now = new Date(), limit = 200) {
  if (!bucket) return 0;
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const staleClaim = new Date(now.getTime() - 15 * 60 * 1_000).toISOString();
  const boundedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const rows = await database.prepare(`
    SELECT key,status FROM uploaded_media
    WHERE (
      status='pending' AND created_at<?
      AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key)
    ) OR (status='pruning' AND claimed_at<?)
    ORDER BY COALESCE(claimed_at,created_at),key
    LIMIT ?
  `).bind(sevenDaysAgo, staleClaim, boundedLimit).all();
  let removed = 0;
  for (const row of rows.results) {
    const claimed = await database.prepare(`
      UPDATE uploaded_media SET status='pruning',claimed_at=?,claim_token=NULL
      WHERE key=? AND (
        (status='pending' AND created_at<?
          AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key))
        OR (status='pruning' AND claimed_at<?)
      )
    `).bind(now.toISOString(), row.key, sevenDaysAgo, staleClaim).run();
    if (Number(claimed.meta.changes) !== 1) continue;
    try {
      await bucket.delete(row.key);
      const deleted = await database.prepare(
        "DELETE FROM uploaded_media WHERE key=? AND status='pruning'",
      ).bind(row.key).run();
      removed += Number(deleted.meta.changes);
    } catch {
      await database.prepare(
        "UPDATE uploaded_media SET status='pending',claimed_at=NULL WHERE key=? AND status='pruning'",
      ).bind(row.key).run().catch(() => undefined);
    }
  }
  return removed;
}

export async function runRetentionMaintenance(database, bucket, now = new Date()) {
  const sevenDaysAgo = new Date(now.getTime() - 7 * DAY_MS).toISOString();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const nowIso = now.toISOString();
  const expiredPostIds = `
    SELECT id FROM posts
    WHERE status='deleted' AND deleted_at IS NOT NULL AND deleted_at<?
    ORDER BY deleted_at,id LIMIT 500
  `;
  await database.batch([
    database.prepare(`
      DELETE FROM post_poll_votes
      WHERE poll_id IN (SELECT id FROM post_polls WHERE post_id IN (${expiredPostIds}))
    `).bind(sevenDaysAgo),
    database.prepare(`
      DELETE FROM post_poll_options
      WHERE poll_id IN (SELECT id FROM post_polls WHERE post_id IN (${expiredPostIds}))
    `).bind(sevenDaysAgo),
    database.prepare(`DELETE FROM post_polls WHERE post_id IN (${expiredPostIds})`).bind(sevenDaysAgo),
    database.prepare(`DELETE FROM post_recommendations WHERE post_id IN (${expiredPostIds})`).bind(sevenDaysAgo),
    database.prepare(`DELETE FROM post_reports WHERE post_id IN (${expiredPostIds})`).bind(sevenDaysAgo),
    database.prepare(`DELETE FROM post_comments WHERE post_id IN (${expiredPostIds})`).bind(sevenDaysAgo),
    database.prepare(`
      DELETE FROM posts
      WHERE id IN (${expiredPostIds})
    `).bind(sevenDaysAgo),
    database.prepare(`
      DELETE FROM admin_account_login_failures
      WHERE username IN (
        SELECT username FROM admin_account_login_failures
        WHERE blocked_until<? AND updated_at<?
        ORDER BY updated_at,username LIMIT 1000
      )
    `).bind(nowIso, thirtyDaysAgo),
    database.prepare(`
      DELETE FROM admin_ip_login_failures
      WHERE ip IN (
        SELECT ip FROM admin_ip_login_failures
        WHERE blocked_until<? AND updated_at<?
        ORDER BY updated_at,ip LIMIT 1000
      )
    `).bind(nowIso, thirtyDaysAgo),
    database.prepare(`
      DELETE FROM member_account_login_failures
      WHERE username IN (
        SELECT username FROM member_account_login_failures
        WHERE blocked_until<? AND updated_at<?
        ORDER BY updated_at,username LIMIT 1000
      )
    `).bind(nowIso, thirtyDaysAgo),
    database.prepare(`
      DELETE FROM member_ip_login_failures
      WHERE ip IN (
        SELECT ip FROM member_ip_login_failures
        WHERE blocked_until<? AND updated_at<?
        ORDER BY updated_at,ip LIMIT 1000
      )
    `).bind(nowIso, thirtyDaysAgo),
    database.prepare(`
      DELETE FROM outbox_jobs
      WHERE id IN (
        SELECT id FROM outbox_jobs
        WHERE status IN ('complete','failed') AND completed_at<?
        ORDER BY completed_at,id LIMIT 1000
      )
    `).bind(sevenDaysAgo),
  ]);
  return pruneMediaRetention(database, bucket, now);
}
