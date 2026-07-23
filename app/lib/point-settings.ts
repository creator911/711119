import { MEMBER_LEVEL_REQUIREMENTS, attendancePointsForLevel as defaultAttendancePointsForLevel, automaticMemberLevel as defaultAutomaticMemberLevel } from "./member-level";

export type PointRewardList = [number, number, number];
export type PointLevelRequirement = { level: 2 | 3 | 4 | 5; attendance: number; posts: number; comments: number };
export type PointSystemSettings = {
  postCreatePoints: number;
  reviewCreatePoints: number;
  commentCreatePoints: number;
  attendanceBasePoints: number;
  attendanceLevelStepPoints: number;
  levelRequirements: PointLevelRequirement[];
  eventRewards: {
    weekly: { posts: PointRewardList; comments: PointRewardList };
    monthly: { posts: PointRewardList; comments: PointRewardList };
  };
};

const SETTING_KEY = "point_system";
const MAX_POINT_VALUE = 10_000_000;
const MAX_REQUIREMENT_VALUE = 1_000_000;

export const DEFAULT_POINT_SETTINGS: PointSystemSettings = {
  postCreatePoints: 10,
  reviewCreatePoints: 50,
  commentCreatePoints: 5,
  attendanceBasePoints: 50,
  attendanceLevelStepPoints: 10,
  levelRequirements: MEMBER_LEVEL_REQUIREMENTS.map((item) => ({
    level: item.level as 2 | 3 | 4 | 5,
    attendance: item.attendance,
    posts: item.posts,
    comments: item.comments,
  })).sort((left, right) => left.level - right.level),
  eventRewards: {
    weekly: { posts: [10000, 5000, 1000], comments: [10000, 5000, 1000] },
    monthly: { posts: [10000, 5000, 1000], comments: [10000, 5000, 1000] },
  },
};

type SettingsDatabase = Pick<D1Database, "prepare">;

const clampInteger = (value: unknown, fallback: number, max = MAX_POINT_VALUE) => {
  const parsed = typeof value === "number" ? value : typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(max, Math.trunc(parsed)));
};

const normalizeRewardList = (value: unknown, fallback: PointRewardList): PointRewardList => {
  const source = Array.isArray(value) ? value : [];
  return [0, 1, 2].map((index) => clampInteger(source[index], fallback[index])) as PointRewardList;
};

const normalizeLevelRequirements = (value: unknown): PointLevelRequirement[] => {
  const rows = Array.isArray(value) ? value : [];
  return DEFAULT_POINT_SETTINGS.levelRequirements.map((fallback) => {
    const source = rows.find((row) => row && typeof row === "object" && Number((row as { level?: unknown }).level) === fallback.level) as Partial<PointLevelRequirement> | undefined;
    return {
      level: fallback.level,
      attendance: clampInteger(source?.attendance, fallback.attendance, MAX_REQUIREMENT_VALUE),
      posts: clampInteger(source?.posts, fallback.posts, MAX_REQUIREMENT_VALUE),
      comments: clampInteger(source?.comments, fallback.comments, MAX_REQUIREMENT_VALUE),
    };
  });
};

export function normalizePointSettings(value: unknown): PointSystemSettings {
  const source = value && typeof value === "object" ? value as Partial<PointSystemSettings> : {};
  return {
    postCreatePoints: clampInteger(source.postCreatePoints, DEFAULT_POINT_SETTINGS.postCreatePoints),
    reviewCreatePoints: clampInteger(source.reviewCreatePoints, DEFAULT_POINT_SETTINGS.reviewCreatePoints),
    commentCreatePoints: clampInteger(source.commentCreatePoints, DEFAULT_POINT_SETTINGS.commentCreatePoints),
    attendanceBasePoints: clampInteger(source.attendanceBasePoints, DEFAULT_POINT_SETTINGS.attendanceBasePoints),
    attendanceLevelStepPoints: clampInteger(source.attendanceLevelStepPoints, DEFAULT_POINT_SETTINGS.attendanceLevelStepPoints),
    levelRequirements: normalizeLevelRequirements(source.levelRequirements),
    eventRewards: {
      weekly: {
        posts: normalizeRewardList(source.eventRewards?.weekly?.posts, DEFAULT_POINT_SETTINGS.eventRewards.weekly.posts),
        comments: normalizeRewardList(source.eventRewards?.weekly?.comments, DEFAULT_POINT_SETTINGS.eventRewards.weekly.comments),
      },
      monthly: {
        posts: normalizeRewardList(source.eventRewards?.monthly?.posts, DEFAULT_POINT_SETTINGS.eventRewards.monthly.posts),
        comments: normalizeRewardList(source.eventRewards?.monthly?.comments, DEFAULT_POINT_SETTINGS.eventRewards.monthly.comments),
      },
    },
  };
}

async function initializeSettingsTable(db: SettingsDatabase) {
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT 'system',
      updated_at TEXT NOT NULL
    )
  `).run();
  await db.prepare(`
    INSERT OR IGNORE INTO site_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)
  `).bind(SETTING_KEY, JSON.stringify(DEFAULT_POINT_SETTINGS), "system", new Date().toISOString()).run();
}

export async function loadPointSettings(db: SettingsDatabase): Promise<PointSystemSettings> {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key=?").bind(SETTING_KEY).first<{ value: string }>();
  if (!row?.value) return DEFAULT_POINT_SETTINGS;
  try {
    return normalizePointSettings(JSON.parse(row.value));
  } catch {
    return DEFAULT_POINT_SETTINGS;
  }
}

export async function savePointSettings(db: SettingsDatabase, input: unknown, updatedBy: string) {
  await initializeSettingsTable(db);
  const settings = normalizePointSettings(input);
  await db.prepare(`
    INSERT INTO site_settings(key,value,updated_by,updated_at) VALUES(?,?,?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
  `).bind(SETTING_KEY, JSON.stringify(settings), updatedBy, new Date().toISOString()).run();
  return settings;
}

export const attendancePointsForSettings = (level: number, settings: PointSystemSettings) =>
  defaultAttendancePointsForLevel(level, settings.attendanceBasePoints, settings.attendanceLevelStepPoints);

export const automaticMemberLevelForSettings = (postCount: number, commentCount: number, attendanceCount: number, settings: PointSystemSettings) =>
  defaultAutomaticMemberLevel(postCount, commentCount, attendanceCount, [...settings.levelRequirements].sort((left, right) => right.level - left.level));
