import { loadPointSettings, type PointRewardList } from "./point-settings";

export type EventPeriodType = "weekly" | "monthly";
export type EventBoardType = "posts" | "comments";

export type EventRankRow = {
  rank: number;
  userId: number;
  nickname: string;
  level: number;
  count: number;
  rewardPoints: number;
  paid: boolean;
};

const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
type PeriodRange = {
  type: EventPeriodType;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
};

type CountRow = {
  userId: number;
  nickname: string;
  level: number;
  count: number;
};

const pad = (value: number) => String(value).padStart(2, "0");
const ymd = (year: number, month: number, day: number) => `${year}-${pad(month)}-${pad(day)}`;

function kstParts(date: Date) {
  const shifted = new Date(date.getTime() + KST_OFFSET_MS);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
  };
}

function utcFromKstDate(year: number, month: number, day: number) {
  return Date.UTC(year, month - 1, day) - KST_OFFSET_MS;
}

function dateLabelFromUtc(ms: number) {
  const parts = kstParts(new Date(ms + 1000));
  return ymd(parts.year, parts.month, parts.day);
}

function rangeFromUtc(type: EventPeriodType, startUtc: number, endUtc: number): PeriodRange {
  const start = kstParts(new Date(startUtc));
  const end = kstParts(new Date(endUtc - 1000));
  return {
    type,
    startAt: new Date(startUtc).toISOString(),
    endAt: new Date(endUtc).toISOString(),
    startDate: ymd(start.year, start.month, start.day),
    endDate: ymd(end.year, end.month, end.day),
  };
}

function currentPeriod(type: EventPeriodType, now = new Date()): PeriodRange {
  const parts = kstParts(now);
  if (type === "monthly") {
    const startUtc = utcFromKstDate(parts.year, parts.month, 1);
    const endUtc = utcFromKstDate(parts.year, parts.month + 1, 1);
    return rangeFromUtc(type, startUtc, endUtc);
  }

  const todayMidnightUtc = utcFromKstDate(parts.year, parts.month, parts.day);
  const daysAfterMonday = (parts.weekday + 6) % 7;
  const startUtc = todayMidnightUtc - daysAfterMonday * DAY_MS;
  const endUtc = startUtc + 7 * DAY_MS;
  return rangeFromUtc(type, startUtc, endUtc);
}

function previousPeriod(type: EventPeriodType, now = new Date()): PeriodRange {
  const current = currentPeriod(type, now);
  const currentStart = Date.parse(current.startAt);
  if (type === "weekly") return rangeFromUtc(type, currentStart - 7 * DAY_MS, currentStart);

  const currentStartParts = kstParts(new Date(currentStart));
  const previousStartUtc = utcFromKstDate(currentStartParts.year, currentStartParts.month - 1, 1);
  return rangeFromUtc(type, previousStartUtc, currentStart);
}

async function queryRankCounts(db: D1Database, boardType: EventBoardType, period: PeriodRange) {
  if (boardType === "posts") {
    const rows = await db.prepare(`
      SELECT u.id AS userId, u.nickname, COALESCE(u.level,1) AS level, COUNT(*) AS count
      FROM posts p JOIN users u ON u.id = p.author_id
      WHERE p.status = 'published'
        AND p.author_id > 0
        AND p.category IN ('reviews','gifs','community')
        AND p.created_at >= ? AND p.created_at < ?
      GROUP BY p.author_id, u.id, u.nickname, u.level
      ORDER BY count DESC, u.id ASC
      LIMIT 10
    `).bind(period.startAt, period.endAt).all<CountRow>();
    return rows.results ?? [];
  }

  const rows = await db.prepare(`
    SELECT u.id AS userId, u.nickname, COALESCE(u.level,1) AS level, SUM(activity_count) AS count
    FROM (
      SELECT c.user_id AS user_id, COUNT(*) AS activity_count
      FROM post_comments c
      WHERE c.status = 'published'
        AND c.created_at >= ? AND c.created_at < ?
      GROUP BY c.user_id
      UNION ALL
      SELECT a.user_id AS user_id, COUNT(*) AS activity_count
      FROM attendance a
      WHERE a.attendance_date >= ? AND a.attendance_date <= ?
      GROUP BY a.user_id
    ) activity
    JOIN users u ON u.id = activity.user_id
    GROUP BY u.id, u.nickname, u.level
    ORDER BY count DESC, u.id ASC
    LIMIT 10
  `).bind(period.startAt, period.endAt, period.startDate, period.endDate).all<CountRow>();
  return rows.results ?? [];
}

async function paidUserIds(db: D1Database, period: PeriodRange, boardType: EventBoardType) {
  const rows = await db.prepare(`
    SELECT user_id AS userId
    FROM event_reward_payouts
    WHERE period_type = ? AND board_type = ? AND period_start = ?
  `).bind(period.type, boardType, period.startAt).all<{ userId: number }>();
  return new Set((rows.results ?? []).map((row) => row.userId));
}

async function rankRows(db: D1Database, period: PeriodRange, boardType: EventBoardType, rewardPoints: PointRewardList): Promise<EventRankRow[]> {
  const [counts, paid] = await Promise.all([queryRankCounts(db, boardType, period), paidUserIds(db, period, boardType)]);
  return counts.map((row, index) => ({
    rank: index + 1,
    userId: row.userId,
    nickname: row.nickname,
    level: row.level,
    count: Number(row.count) || 0,
    rewardPoints: rewardPoints[index] ?? 0,
    paid: paid.has(row.userId),
  }));
}

async function settlePeriod(db: D1Database, period: PeriodRange, boardType: EventBoardType, rewardPoints: PointRewardList, now = new Date()) {
  if (Date.parse(period.endAt) > now.getTime()) return;
  const rows = await rankRows(db, period, boardType, rewardPoints);
  const nowIso = now.toISOString();
  for (const row of rows.slice(0, 3)) {
    if (row.count < 1 || row.rewardPoints < 1) continue;
    const reference = `event:${period.type}:${boardType}:${dateLabelFromUtc(Date.parse(period.startAt))}:rank${row.rank}`;
    const inserted = await db.prepare(`
      INSERT OR IGNORE INTO event_reward_payouts(period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,created_at)
      VALUES(?,?,?,?,?,?,?,?,?)
    `).bind(period.type, boardType, period.startAt, period.endAt, row.userId, row.rank, row.count, row.rewardPoints, nowIso).run();
    if ((inserted.meta as { changes?: number }).changes === 0) continue;
    await db.batch([
      db.prepare("UPDATE users SET points = points + ? WHERE id = ?").bind(row.rewardPoints, row.userId),
      db.prepare("INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at) VALUES(?,?,'event_reward','complete',?,?)").bind(row.userId, row.rewardPoints, reference, nowIso),
    ]);
  }
}

export async function loadEventLeaderboard(db: D1Database, type: EventPeriodType) {
  const now = new Date();
  const pointSettings = await loadPointSettings(db);
  await Promise.all([
    settlePeriod(db, previousPeriod("weekly", now), "posts", pointSettings.eventRewards.weekly.posts, now),
    settlePeriod(db, previousPeriod("weekly", now), "comments", pointSettings.eventRewards.weekly.comments, now),
    settlePeriod(db, previousPeriod("monthly", now), "posts", pointSettings.eventRewards.monthly.posts, now),
    settlePeriod(db, previousPeriod("monthly", now), "comments", pointSettings.eventRewards.monthly.comments, now),
  ]);

  const period = currentPeriod(type, now);
  const rewards = pointSettings.eventRewards[type];
  const [posts, comments] = await Promise.all([
    rankRows(db, period, "posts", rewards.posts),
    rankRows(db, period, "comments", rewards.comments),
  ]);

  return {
    period,
    rewards,
    posts,
    comments,
  };
}
