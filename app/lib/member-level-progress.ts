import { automaticMemberLevel, MAX_AUTOMATIC_MEMBER_LEVEL } from "./member-level";
import { loadPointSettings, type PointSystemSettings } from "./point-settings";

type PreparedStatement<T = unknown> = {
  bind: (...values: T[]) => {
    first: <R = unknown>() => Promise<R | null>;
    run: () => Promise<{ meta?: { changes?: number } }>;
  };
  first: <R = unknown>() => Promise<R | null>;
};

type LevelProgressDatabase = {
  prepare: (query: string) => PreparedStatement;
};

export type LevelProgressRow = {
  id: number;
  level: number;
  levelLocked: number | boolean;
  postCount: number;
  commentCount: number;
  attendanceCount: number;
};

export async function loadMemberLevelProgressRow(database: LevelProgressDatabase, userId: number) {
  return database.prepare(`
    SELECT u.id,u.level,u.level_locked AS levelLocked,
           COALESCE(s.post_count,0) AS postCount,
           COALESCE(s.comment_count,0) AS commentCount,
           COALESCE(s.attendance_count,0) AS attendanceCount
    FROM users u
    LEFT JOIN member_activity_stats s ON s.user_id=u.id
    WHERE u.id=?
  `).bind(userId).first<LevelProgressRow>();
}

/**
 * Automatic refresh is called after every post and comment. Once a member is
 * locked or has reached the automatic ceiling, the CASE branches avoid all
 * three activity COUNT subqueries while keeping the hot path to one read.
 */
async function loadAutomaticLevelProgressRow(database: LevelProgressDatabase, userId: number) {
  return database.prepare(`
    SELECT u.id,u.level,u.level_locked AS levelLocked,
           CASE WHEN u.level_locked=0 AND u.level<?
             THEN COALESCE(s.post_count,0) ELSE 0 END AS postCount,
           CASE WHEN u.level_locked=0 AND u.level<?
             THEN COALESCE(s.comment_count,0) ELSE 0 END AS commentCount,
           CASE WHEN u.level_locked=0 AND u.level<?
             THEN COALESCE(s.attendance_count,0) ELSE 0 END AS attendanceCount
    FROM users u
    LEFT JOIN member_activity_stats s ON s.user_id=u.id
    WHERE u.id=?
  `).bind(MAX_AUTOMATIC_MEMBER_LEVEL, MAX_AUTOMATIC_MEMBER_LEVEL, MAX_AUTOMATIC_MEMBER_LEVEL, userId).first<LevelProgressRow>();
}

export async function refreshAutomaticMemberLevelFromProgressRow(
  database: LevelProgressDatabase,
  row: LevelProgressRow,
  loadedSettings?: PointSystemSettings,
) {
  if (Boolean(row.levelLocked) || row.level >= MAX_AUTOMATIC_MEMBER_LEVEL) return row;

  const settings = loadedSettings ?? await loadPointSettings(database as unknown as D1Database);
  const calculatedLevel = Math.min(MAX_AUTOMATIC_MEMBER_LEVEL, automaticMemberLevel(row.postCount, row.commentCount, row.attendanceCount, [...settings.levelRequirements].sort((left, right) => right.level - left.level)));
  const nextLevel = Math.max(1, row.level, calculatedLevel);
  if (nextLevel !== row.level) {
    const updated = await database.prepare(`
      UPDATE users SET level=?
      WHERE id=? AND level=? AND level_locked=0 AND level<?
    `).bind(nextLevel, row.id, row.level, MAX_AUTOMATIC_MEMBER_LEVEL).run();
    if (Number(updated.meta?.changes) === 1) return { ...row, level: nextLevel };

    // An operator may lock or assign a level between the aggregate read and
    // update. Never report a level that lost that race.
    const current = await database.prepare(`
      SELECT id,level,level_locked AS levelLocked FROM users WHERE id=?
    `).bind(row.id).first<Pick<LevelProgressRow, "id" | "level" | "levelLocked">>();
    return current ? { ...row, ...current } : row;
  }
  return row;
}

export async function refreshAutomaticMemberLevel(database: LevelProgressDatabase, userId: number) {
  const row = await loadAutomaticLevelProgressRow(database, userId);
  if (!row) return 1;
  const refreshed = await refreshAutomaticMemberLevelFromProgressRow(database, row);
  return refreshed.level;
}
