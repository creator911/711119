import { automaticMemberLevel, MAX_AUTOMATIC_MEMBER_LEVEL } from "./member-level";

type PreparedStatement<T = unknown> = {
  bind: (...values: T[]) => {
    first: <R = unknown>() => Promise<R | null>;
    run: () => Promise<unknown>;
  };
  first: <R = unknown>() => Promise<R | null>;
};

type LevelProgressDatabase = {
  prepare: (query: string) => PreparedStatement;
};

type LevelProgressRow = {
  id: number;
  level: number;
  levelLocked: number | boolean;
  postCount: number;
  commentCount: number;
};

export async function refreshAutomaticMemberLevel(database: LevelProgressDatabase, userId: number) {
  const row = await database.prepare(`
    SELECT u.id,u.level,u.level_locked AS levelLocked,
           (SELECT COUNT(*) FROM posts p WHERE p.author_id=u.id AND p.status='published') AS postCount,
           (SELECT COUNT(*) FROM post_comments c WHERE c.user_id=u.id AND c.status='published') AS commentCount
    FROM users u
    WHERE u.id=?
  `).bind(userId).first<LevelProgressRow>();

  if (!row) return 1;
  if (Boolean(row.levelLocked) || row.level >= 10) return row.level;

  const calculatedLevel = Math.min(MAX_AUTOMATIC_MEMBER_LEVEL, automaticMemberLevel(row.postCount, row.commentCount));
  const nextLevel = Math.max(1, row.level, calculatedLevel);
  if (nextLevel !== row.level) {
    await database.prepare("UPDATE users SET level=? WHERE id=? AND level_locked=0 AND level<10").bind(nextLevel, userId).run();
  }
  return nextLevel;
}
