type ContentRewardDatabase = Pick<D1Database, "prepare" | "batch">;

type PublishedReward = { earnedPoints: number; reference: string | null };

const STALE_PREPARED_CONTENT_TTL_MS = 24 * 60 * 60 * 1000;
const STALE_PREPARED_CONTENT_LIMIT = 64;
const STALE_PREPARED_CONTENT_SAMPLE_MODULUS = 64;

export class ContentPublishError extends Error {}

const safePoints = (value: number) => Math.max(0, Math.trunc(Number.isFinite(value) ? value : 0));

/**
 * A worker can be interrupted after the invisible draft/pending INSERT but
 * before the publication batch. One out of every 64 new content ids performs
 * a small indexed sweep so those crash remnants cannot accumulate forever.
 */
export async function maybePruneStalePreparedContent(
  database: ContentRewardDatabase,
  sequenceId: number,
  nowMs = Date.now(),
) {
  if (!Number.isInteger(sequenceId) || sequenceId < 1 || sequenceId % STALE_PREPARED_CONTENT_SAMPLE_MODULUS !== 0) {
    return { ran: false, posts: 0, comments: 0 };
  }
  const cutoff = new Date(nowMs - STALE_PREPARED_CONTENT_TTL_MS).toISOString();
  const [drafts, pendingComments] = await Promise.all([
    database.prepare(`
      SELECT id FROM posts
      WHERE status='draft' AND created_at<?
      ORDER BY created_at ASC,id ASC LIMIT ?
    `).bind(cutoff, STALE_PREPARED_CONTENT_LIMIT).all<{ id: number }>(),
    database.prepare(`
      SELECT id FROM post_comments
      WHERE status='pending' AND created_at<?
      ORDER BY created_at ASC,id ASC LIMIT ?
    `).bind(cutoff, STALE_PREPARED_CONTENT_LIMIT).all<{ id: number }>(),
  ]);
  const postIds = drafts.results.map(({ id }) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  const commentIds = pendingComments.results.map(({ id }) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
  if (!postIds.length && !commentIds.length) return { ran: true, posts: 0, comments: 0 };

  const statements: D1PreparedStatement[] = [];
  if (postIds.length) {
    const placeholders = postIds.map(() => "?").join(",");
    const stalePolls = `
      SELECT pp.id FROM post_polls pp
      JOIN posts p ON p.id=pp.post_id
      WHERE p.id IN (${placeholders}) AND p.status='draft' AND p.created_at<?
    `;
    statements.push(
      database.prepare(`DELETE FROM post_poll_votes WHERE poll_id IN (${stalePolls})`).bind(...postIds, cutoff),
      database.prepare(`DELETE FROM post_poll_options WHERE poll_id IN (${stalePolls})`).bind(...postIds, cutoff),
      database.prepare(`DELETE FROM post_polls WHERE id IN (${stalePolls})`).bind(...postIds, cutoff),
      database.prepare(`
        DELETE FROM posts
        WHERE id IN (${placeholders}) AND status='draft' AND created_at<?
      `).bind(...postIds, cutoff),
    );
  }
  if (commentIds.length) {
    const placeholders = commentIds.map(() => "?").join(",");
    statements.push(database.prepare(`
      DELETE FROM post_comments
      WHERE id IN (${placeholders}) AND status='pending' AND created_at<?
    `).bind(...commentIds, cutoff));
  }

  const results = await database.batch(statements);
  const deletedPosts = postIds.length ? Number(results[3]?.meta?.changes) || 0 : 0;
  const deletedComments = Number(results.at(-1)?.meta?.changes) || 0;
  return { ran: true, posts: deletedPosts, comments: commentIds.length ? deletedComments : 0 };
}

async function publishedPostReward(
  database: ContentRewardDatabase,
  postId: number,
  authorId: number,
  type: string,
  reference: string,
) {
  const statement = database.prepare(`
    SELECT p.status,
      (SELECT amount FROM point_ledger
       WHERE user_id=? AND type=? AND reference=? AND status='complete'
       ORDER BY id ASC LIMIT 1) AS earnedPoints
    FROM posts p
    WHERE p.id=? AND p.author_id=?
  `).bind(authorId, type, reference, postId, authorId);
  return statement.first<{ status: string; earnedPoints: number | null }>();
}

async function publishedCommentReward(
  database: ContentRewardDatabase,
  commentId: number,
  postId: number,
  authorId: number,
  reference: string,
) {
  const statement = database.prepare(`
    SELECT c.status,
      (SELECT amount FROM point_ledger
       WHERE user_id=? AND type='comment_create' AND reference=? AND status='complete'
       ORDER BY id ASC LIMIT 1) AS earnedPoints
    FROM post_comments c
    WHERE c.id=? AND c.post_id=? AND c.user_id=?
  `).bind(authorId, reference, commentId, postId, authorId);
  return statement.first<{ status: string; earnedPoints: number | null }>();
}

/**
 * Publishes a prepared post and applies its configured point reward in one D1
 * batch transaction. The draft-state guard makes a replay a no-op, while the
 * content-reward ledger unique index is the durable second line of defense.
 */
export async function publishPostWithReward(
  database: ContentRewardDatabase,
  input: {
    postId: number;
    authorId: number;
    category: string;
    points: number;
    createdAt: string;
    afterPublishStatements?: D1PreparedStatement[];
  },
): Promise<PublishedReward> {
  const points = safePoints(input.points);
  const type = input.category === "reviews" ? "review_create" : "post_create";
  const reference = `${input.category}:${input.postId}`;
  const draftGuard = `EXISTS(
    SELECT 1 FROM posts p
    WHERE p.id=? AND p.author_id=? AND p.status='draft'
  )`;
  const statements: D1PreparedStatement[] = [];

  if (points > 0) {
    statements.push(
      database.prepare(`
        INSERT OR IGNORE INTO point_ledger(user_id,amount,type,status,reference,created_at)
        SELECT ?,?,?,'complete',?,?
        WHERE ${draftGuard}
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
      `).bind(
        input.authorId, points, type, reference, input.createdAt,
        input.postId, input.authorId, input.authorId,
      ),
      database.prepare(`
        UPDATE users SET points=points+?
        WHERE id=? AND status='active' AND ${draftGuard}
          AND EXISTS(
            SELECT 1 FROM point_ledger
            WHERE user_id=? AND type=? AND reference=? AND status='complete'
          )
      `).bind(
        points, input.authorId,
        input.postId, input.authorId,
        input.authorId, type, reference,
      ),
      database.prepare(`
        UPDATE posts SET status='published'
        WHERE id=? AND author_id=? AND status='draft'
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
          AND EXISTS(
            SELECT 1 FROM point_ledger
            WHERE user_id=? AND type=? AND reference=? AND status='complete'
          )
      `).bind(
        input.postId, input.authorId, input.authorId,
        input.authorId, type, reference,
      ),
    );
  } else {
    statements.push(database.prepare(`
      UPDATE posts SET status='published'
      WHERE id=? AND author_id=? AND status='draft'
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
    `).bind(input.postId, input.authorId, input.authorId));
  }

  const publicationStatementIndex = statements.length - 1;
  statements.push(...(input.afterPublishStatements ?? []));
  let results;
  try {
    results = await database.batch(statements);
  } catch (batchError) {
    // A remote D1 response can be lost after the transaction committed. Check
    // the durable state before reporting failure so the route does not create
    // a duplicate or try to roll back an already-published resource.
    const existing = await publishedPostReward(database, input.postId, input.authorId, type, reference).catch(() => null);
    if (existing?.status === "published" && (points === 0 || existing.earnedPoints !== null)) {
      return { earnedPoints: Number(existing.earnedPoints) || 0, reference: existing.earnedPoints !== null ? reference : null };
    }
    throw batchError;
  }
  if (Number(results[publicationStatementIndex]?.meta?.changes) === 1) {
    return { earnedPoints: points, reference: points > 0 ? reference : null };
  }

  // A response retry after the batch committed must not award the same post
  // twice. Return the durable result when this exact post is already public.
  const existing = await publishedPostReward(database, input.postId, input.authorId, type, reference);
  if (existing?.status === "published" && (points === 0 || existing.earnedPoints !== null)) {
    return { earnedPoints: Number(existing.earnedPoints) || 0, reference: existing.earnedPoints !== null ? reference : null };
  }
  throw new ContentPublishError("post_publish_reward_not_committed");
}

/** Publishes a prepared comment and awards its points in the same transaction. */
export async function publishCommentWithReward(
  database: ContentRewardDatabase,
  input: { commentId: number; postId: number; authorId: number; points: number; createdAt: string },
): Promise<PublishedReward> {
  const points = safePoints(input.points);
  const reference = `post:${input.postId}:comment:${input.commentId}`;
  const pendingGuard = `EXISTS(
    SELECT 1 FROM post_comments c
    JOIN posts p ON p.id=c.post_id
    WHERE c.id=? AND c.post_id=? AND c.user_id=? AND c.status='pending'
      AND p.status='published'
  )`;
  const statements: D1PreparedStatement[] = [];

  if (points > 0) {
    statements.push(
      database.prepare(`
        INSERT OR IGNORE INTO point_ledger(user_id,amount,type,status,reference,created_at)
        SELECT ?,?,'comment_create','complete',?,?
        WHERE ${pendingGuard}
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
      `).bind(
        input.authorId, points, reference, input.createdAt,
        input.commentId, input.postId, input.authorId, input.authorId,
      ),
      database.prepare(`
        UPDATE users SET points=points+?
        WHERE id=? AND status='active' AND ${pendingGuard}
          AND EXISTS(
            SELECT 1 FROM point_ledger
            WHERE user_id=? AND type='comment_create' AND reference=? AND status='complete'
          )
      `).bind(
        points, input.authorId,
        input.commentId, input.postId, input.authorId,
        input.authorId, reference,
      ),
      database.prepare(`
        UPDATE post_comments SET status='published'
        WHERE id=? AND post_id=? AND user_id=? AND status='pending'
          AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
          AND EXISTS(
            SELECT 1 FROM point_ledger
            WHERE user_id=? AND type='comment_create' AND reference=? AND status='complete'
          )
      `).bind(
        input.commentId, input.postId, input.authorId, input.authorId,
        input.authorId, reference,
      ),
    );
  } else {
    statements.push(database.prepare(`
      UPDATE post_comments SET status='published'
      WHERE id=? AND post_id=? AND user_id=? AND status='pending'
        AND EXISTS(SELECT 1 FROM users WHERE id=? AND status='active')
        AND EXISTS(SELECT 1 FROM posts WHERE id=? AND status='published')
    `).bind(input.commentId, input.postId, input.authorId, input.authorId, input.postId));
  }

  let results;
  try {
    results = await database.batch(statements);
  } catch (batchError) {
    const existing = await publishedCommentReward(database, input.commentId, input.postId, input.authorId, reference).catch(() => null);
    if (existing?.status === "published" && (points === 0 || existing.earnedPoints !== null)) {
      return { earnedPoints: Number(existing.earnedPoints) || 0, reference: existing.earnedPoints !== null ? reference : null };
    }
    throw batchError;
  }
  if (Number(results.at(-1)?.meta?.changes) === 1) {
    return { earnedPoints: points, reference: points > 0 ? reference : null };
  }

  const existing = await publishedCommentReward(database, input.commentId, input.postId, input.authorId, reference);
  if (existing?.status === "published" && (points === 0 || existing.earnedPoints !== null)) {
    return { earnedPoints: Number(existing.earnedPoints) || 0, reference: existing.earnedPoints !== null ? reference : null };
  }
  throw new ContentPublishError("comment_publish_reward_not_committed");
}
