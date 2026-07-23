import { loadPointSettings, type PointRewardList } from "./point-settings";
import { enqueueSettledRollupCleanup, pruneSettledEventRollups } from "./event-rollup-retention";

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
const SETTLEMENT_LEASE_MS = 5 * 60 * 1000;
const LEADERBOARD_SNAPSHOT_TTL_MS = 5 * 60 * 1000;
const LEADERBOARD_REFRESH_LEASE_MS = 2 * 60 * 1000;
const LEADERBOARD_REFRESH_WAIT_MS = 2 * 1000;
const LEADERBOARD_REFRESH_POLL_MS = 100;
const SETTLEMENT_PERIODS_PER_RUN = 4;
const leaderboardRefreshes = new Map<string, Promise<CountRow[]>>();
type PeriodRange = {
  type: EventPeriodType;
  startAt: string;
  endAt: string;
  startDate: string;
  endDate: string;
};

export type AdminEventRewardRow = {
  boardType: EventBoardType;
  rank: number;
  userId: number | null;
  nickname: string | null;
  level: number | null;
  activityCount: number;
  points: number;
  paidAt: string | null;
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

function periodFromStart(type: EventPeriodType, startAt: string): PeriodRange | null {
  const startUtc = Date.parse(startAt);
  if (!Number.isFinite(startUtc)) return null;
  if (type === "weekly") return rangeFromUtc(type, startUtc, startUtc + 7 * DAY_MS);
  const start = kstParts(new Date(startUtc));
  return rangeFromUtc(type, startUtc, utcFromKstDate(start.year, start.month + 1, 1));
}

async function queryRankCounts(db: D1Database, boardType: EventBoardType, period: PeriodRange) {
  const rows = await db.prepare(`
    SELECT u.id AS userId, u.nickname, COALESCE(u.level,1) AS level,
      activity.activity_count AS count
    FROM event_activity_rollups activity
    JOIN users u ON u.id = activity.user_id
    WHERE activity.period_type=? AND activity.board_type=? AND activity.period_start=?
      AND activity.activity_count>0
      AND u.status='active' AND COALESCE(u.level,1) BETWEEN 1 AND 9
    ORDER BY activity.activity_count DESC, activity.user_id ASC
    LIMIT 10
  `).bind(period.type, boardType, period.startAt).all<CountRow>();
  return rows.results ?? [];
}

const leaderboardSnapshotKey = (period: PeriodRange, boardType: EventBoardType) =>
  `event_leaderboard_snapshot:${period.type}:${boardType}:${period.startAt}`;

const leaderboardRefreshKey = (period: PeriodRange, boardType: EventBoardType) =>
  `event_leaderboard_refresh:${period.type}:${boardType}:${period.startAt}`;

function parseRankSnapshot(value: string | undefined) {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { generatedAt?: unknown; rows?: unknown };
    if (typeof parsed.generatedAt !== "string" || !Array.isArray(parsed.rows)) return null;
    const rows = parsed.rows.filter((row): row is CountRow => {
      if (!row || typeof row !== "object") return false;
      const item = row as Partial<CountRow>;
      return Number.isInteger(item.userId) && typeof item.nickname === "string"
        && Number.isInteger(item.level) && Number.isFinite(Number(item.count));
    }).slice(0, 10).map((row) => ({ ...row, count: Number(row.count) }));
    return { generatedAt: parsed.generatedAt, rows };
  } catch {
    return null;
  }
}

async function readRankSnapshot(db: D1Database, key: string) {
  const row = await db.prepare("SELECT value FROM site_settings WHERE key=? LIMIT 1")
    .bind(key).first<{ value: string }>();
  return parseRankSnapshot(row?.value);
}

async function claimLeaderboardRefresh(db: D1Database, key: string, now: Date) {
  const existing = await db.prepare("SELECT value,updated_at AS updatedAt FROM site_settings WHERE key=? LIMIT 1")
    .bind(key).first<{ value: string; updatedAt: string }>();
  if (existing?.value.startsWith("pending:")
    && Date.parse(existing.updatedAt) >= now.getTime() - LEADERBOARD_REFRESH_LEASE_MS) return null;

  const claimValue = `pending:${crypto.randomUUID()}`;
  const claimedAt = now.toISOString();
  const expiredBefore = new Date(now.getTime() - LEADERBOARD_REFRESH_LEASE_MS).toISOString();
  await db.prepare(`
    INSERT INTO site_settings(key,value,updated_by,updated_at)
    VALUES(?,?,'event-leaderboard-refresh',?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    WHERE site_settings.value LIKE 'complete:%'
      OR (site_settings.value LIKE 'pending:%' AND site_settings.updated_at < ?)
  `).bind(key, claimValue, claimedAt, expiredBefore).run();
  const row = await db.prepare("SELECT value FROM site_settings WHERE key=? LIMIT 1")
    .bind(key).first<{ value: string }>();
  return row?.value === claimValue ? { key, claimValue } : null;
}

async function waitForRankSnapshot(db: D1Database, key: string) {
  const deadline = Date.now() + LEADERBOARD_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, LEADERBOARD_REFRESH_POLL_MS));
    const refreshed = await readRankSnapshot(db, key);
    if (refreshed) return refreshed;
  }
  return null;
}

async function saveRankSnapshot(
  db: D1Database,
  snapshotKey: string,
  refreshClaim: { key: string; claimValue: string },
  rows: CountRow[],
  generatedAt: Date,
) {
  const generatedAtIso = generatedAt.toISOString();
  const value = JSON.stringify({ generatedAt: generatedAtIso, rows });
  await db.batch([
    db.prepare(`
      INSERT INTO site_settings(key,value,updated_by,updated_at)
      SELECT ?,?,'event-leaderboard-cache',?
      WHERE EXISTS(SELECT 1 FROM site_settings WHERE key=? AND value=?)
      ON CONFLICT(key) DO UPDATE SET
        value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
      WHERE EXISTS(SELECT 1 FROM site_settings WHERE key=? AND value=?)
    `).bind(
      snapshotKey, value, generatedAtIso,
      refreshClaim.key, refreshClaim.claimValue,
      refreshClaim.key, refreshClaim.claimValue,
    ),
    db.prepare(`
      UPDATE site_settings
      SET value=?,updated_by='event-leaderboard-refresh',updated_at=?
      WHERE key=? AND value=?
    `).bind(`complete:${generatedAtIso}`, generatedAtIso, refreshClaim.key, refreshClaim.claimValue),
  ]);
}

async function queryCachedRankCounts(db: D1Database, boardType: EventBoardType, period: PeriodRange, now = new Date()) {
  const snapshotKey = leaderboardSnapshotKey(period, boardType);
  const snapshot = await readRankSnapshot(db, snapshotKey);
  const generatedAt = snapshot ? Date.parse(snapshot.generatedAt) : Number.NaN;
  if (snapshot && Number.isFinite(generatedAt) && now.getTime() - generatedAt < LEADERBOARD_SNAPSHOT_TTL_MS) return snapshot.rows;

  const existingRefresh = leaderboardRefreshes.get(snapshotKey);
  if (existingRefresh) return existingRefresh;

  const refresh = (async () => {
    try {
      const claim = await claimLeaderboardRefresh(db, leaderboardRefreshKey(period, boardType), now);
      if (!claim) {
        // Another isolate owns the refresh. Serve stale data immediately when
        // possible; on a cold cache, wait briefly for the owner's snapshot.
        if (snapshot) return snapshot.rows;
        return (await waitForRankSnapshot(db, snapshotKey))?.rows ?? [];
      }
      const rows = await queryRankCounts(db, boardType, period);
      await saveRankSnapshot(db, snapshotKey, claim, rows, new Date());
      return rows;
    } catch (error) {
      if (snapshot) return snapshot.rows;
      throw error;
    }
  })().finally(() => {
    leaderboardRefreshes.delete(snapshotKey);
  });
  leaderboardRefreshes.set(snapshotKey, refresh);
  return refresh;
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
  const [counts, paid] = await Promise.all([queryCachedRankCounts(db, boardType, period), paidUserIds(db, period, boardType)]);
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

const settlementKey = (period: PeriodRange, boardType: EventBoardType) =>
  `event_reward_settled:${period.type}:${boardType}:${period.startAt}`;

async function claimSettlement(db: D1Database, period: PeriodRange, boardType: EventBoardType, now: Date) {
  const key = settlementKey(period, boardType);
  const existing = await db.prepare("SELECT value,updated_at AS updatedAt FROM site_settings WHERE key=? LIMIT 1")
    .bind(key).first<{ value: string; updatedAt: string }>();
  if (existing?.value.startsWith("complete:")) return null;
  if (existing?.value.startsWith("pending:") && Date.parse(existing.updatedAt) >= now.getTime() - SETTLEMENT_LEASE_MS) return null;
  const claimValue = `pending:${crypto.randomUUID()}`;
  const claimedAt = now.toISOString();
  const expiredBefore = new Date(now.getTime() - SETTLEMENT_LEASE_MS).toISOString();
  await db.prepare(`
    INSERT INTO site_settings(key,value,updated_by,updated_at)
    VALUES(?,?,'event-reward-settlement',?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,updated_by=excluded.updated_by,updated_at=excluded.updated_at
    WHERE site_settings.value LIKE 'pending:%' AND site_settings.updated_at < ?
  `).bind(key, claimValue, claimedAt, expiredBefore).run();
  const row = await db.prepare("SELECT value FROM site_settings WHERE key=? LIMIT 1")
    .bind(key).first<{ value: string }>();
  return row?.value === claimValue ? { key, claimValue } : null;
}

async function settlePeriod(db: D1Database, period: PeriodRange, boardType: EventBoardType, rewardPoints: PointRewardList, now = new Date()) {
  if (Date.parse(period.endAt) > now.getTime()) return;
  const claim = await claimSettlement(db, period, boardType, now);
  if (!claim) return;

  const counts = await queryRankCounts(db, boardType, period);
  const nowIso = now.toISOString();
  const statements = [];
  const rewardReferencePrefix = `event:${period.type}:${boardType}:${dateLabelFromUtc(Date.parse(period.startAt))}:rank`;
  for (const [index, row] of counts.slice(0, 3).entries()) {
    const rank = index + 1;
    const points = rewardPoints[index] ?? 0;
    if (row.count < 1 || points < 1) continue;
    statements.push(db.prepare(`
      INSERT OR IGNORE INTO event_reward_payouts(
        period_type,board_type,period_start,period_end,user_id,rank,activity_count,points,nickname_snapshot,level_snapshot,created_at
      )
      SELECT ?,?,?,?,?,?,?,?,?,?,?
      WHERE NOT EXISTS(
        SELECT 1 FROM event_reward_payouts p
        WHERE p.period_type=? AND p.board_type=? AND p.period_start=? AND p.rank=?
      )
    `).bind(
      period.type, boardType, period.startAt, period.endAt, row.userId, rank, row.count, points, row.nickname, row.level, nowIso,
      period.type, boardType, period.startAt, rank,
    ));
  }

  // Payout rows are authoritative snapshots. Repair every existing payout for
  // this period after inserting missing ranks, regardless of whether the live
  // activity ranking has since changed due to moderation or data repair.
  statements.push(db.prepare(`
    UPDATE users
    SET points=points+COALESCE((
      SELECT SUM(p.points)
      FROM event_reward_payouts p
      WHERE p.period_type=? AND p.board_type=? AND p.period_start=? AND p.user_id=users.id
        AND NOT EXISTS(
          SELECT 1 FROM point_ledger l
          WHERE l.user_id=p.user_id AND l.type='event_reward'
            AND l.reference=? || CAST(p.rank AS TEXT)
        )
    ),0)
    WHERE id IN(
      SELECT p.user_id FROM event_reward_payouts p
      WHERE p.period_type=? AND p.board_type=? AND p.period_start=?
        AND NOT EXISTS(
          SELECT 1 FROM point_ledger l
          WHERE l.user_id=p.user_id AND l.type='event_reward'
            AND l.reference=? || CAST(p.rank AS TEXT)
        )
    )
  `).bind(
    period.type, boardType, period.startAt, rewardReferencePrefix,
    period.type, boardType, period.startAt, rewardReferencePrefix,
  ));
  statements.push(db.prepare(`
    INSERT OR IGNORE INTO point_ledger(user_id,amount,type,status,reference,created_at)
    SELECT p.user_id,p.points,'event_reward','complete',? || CAST(p.rank AS TEXT),?
    FROM event_reward_payouts p
    WHERE p.period_type=? AND p.board_type=? AND p.period_start=?
      AND NOT EXISTS(
        SELECT 1 FROM point_ledger l
        WHERE l.user_id=p.user_id AND l.type='event_reward'
          AND l.reference=? || CAST(p.rank AS TEXT)
      )
  `).bind(rewardReferencePrefix, nowIso, period.type, boardType, period.startAt, rewardReferencePrefix));

  statements.push(db.prepare(`
    UPDATE site_settings
    SET value=?,updated_by='event-reward-settlement',updated_at=?
    WHERE key=? AND value=?
  `).bind(`complete:${Math.min(3, counts.length)}`, nowIso, claim.key, claim.claimValue));

  // D1 batch is transactional. The payout row, point balance, ledger entry and
  // completion marker either all commit or all roll back, and the unique
  // payout/ledger keys make retries and concurrent requests idempotent.
  await db.batch(statements);
}

async function unsettledActivityPeriods(
  db: D1Database,
  type: EventPeriodType,
  beforeStart: string,
  excludedStart: string,
  limit: number,
) {
  if (limit < 1) return [];
  const watermarkKey = `event_reward_catchup_watermark:${type}`;
  const rows = await db.prepare(`
    SELECT DISTINCT r.period_start AS periodStart
    FROM event_activity_rollups r
    WHERE r.period_type=? AND r.period_start<? AND r.period_start<>?
      AND r.period_start>=COALESCE(
        (SELECT value FROM site_settings WHERE key=? LIMIT 1),
        ?
      )
      AND (
        NOT EXISTS(
          SELECT 1 FROM site_settings s
          WHERE s.key='event_reward_settled:' || r.period_type || ':posts:' || r.period_start
            AND s.value LIKE 'complete:%'
        )
        OR NOT EXISTS(
          SELECT 1 FROM site_settings s
          WHERE s.key='event_reward_settled:' || r.period_type || ':comments:' || r.period_start
            AND s.value LIKE 'complete:%'
        )
      )
    ORDER BY r.period_start DESC
    LIMIT ?
  `).bind(type, beforeStart, excludedStart, watermarkKey, beforeStart, limit).all<{ periodStart: string }>();
  return (rows.results ?? [])
    .map((row) => periodFromStart(type, row.periodStart))
    .filter((period): period is PeriodRange => Boolean(period));
}

async function settleDuePeriods(
  db: D1Database,
  type: EventPeriodType,
  rewards: { posts: PointRewardList; comments: PointRewardList },
  now: Date,
) {
  // Always settle the immediately preceding period first so the existing
  // public/admin response contract remains current. Then repair a bounded
  // number of older activity periods; subsequent timer/request runs continue.
  const previous = previousPeriod(type, now);
  await settlePeriod(db, previous, "posts", rewards.posts, now);
  await settlePeriod(db, previous, "comments", rewards.comments, now);
  await enqueueSettledRollupCleanup(db, previous, now);

  const catchUp = await unsettledActivityPeriods(
    db,
    type,
    previous.startAt,
    previous.startAt,
    SETTLEMENT_PERIODS_PER_RUN - 1,
  );
  for (const period of catchUp) {
    await settlePeriod(db, period, "posts", rewards.posts, now);
    await settlePeriod(db, period, "comments", rewards.comments, now);
    await enqueueSettledRollupCleanup(db, period, now);
  }
  await pruneSettledEventRollups(db);
}

export async function settleEventLeaderboard(db: D1Database, type: EventPeriodType, now = new Date()) {
  const pointSettings = await loadPointSettings(db);
  await settleDuePeriods(db, type, pointSettings.eventRewards[type], now);
}

export async function loadEventLeaderboard(db: D1Database, type: EventPeriodType) {
  const now = new Date();
  const pointSettings = await loadPointSettings(db);
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

function rewardSlots(rows: EventRankRow[], boardType: EventBoardType): AdminEventRewardRow[] {
  return [1, 2, 3].map((rank) => {
    const row = rows[rank - 1];
    return {
      boardType,
      rank,
      userId: row?.userId ?? null,
      nickname: row?.nickname ?? null,
      level: row?.level ?? null,
      activityCount: row?.count ?? 0,
      points: row?.rewardPoints ?? 0,
      paidAt: null,
    };
  });
}

export async function loadAdminEventRewardAudit(db: D1Database, type: EventPeriodType) {
  const now = new Date();
  const current = await loadEventLeaderboard(db, type);
  const previous = previousPeriod(type, now);
  const paid = await db.prepare(`
    SELECT p.board_type AS boardType, p.rank, p.user_id AS userId,
      COALESCE(NULLIF(p.nickname_snapshot,''),u.nickname) AS nickname,
      COALESCE(p.level_snapshot,u.level,1) AS level,
      p.activity_count AS activityCount, p.points, p.created_at AS paidAt
    FROM event_reward_payouts p
    LEFT JOIN users u ON u.id = p.user_id
    WHERE p.period_type = ? AND p.period_start = ?
    ORDER BY CASE p.board_type WHEN 'posts' THEN 0 ELSE 1 END, p.rank ASC
  `).bind(type, previous.startAt).all<AdminEventRewardRow>();

  const paidBySlot = new Map((paid.results ?? []).map((row) => [`${row.boardType}:${row.rank}`, row]));
  const previousRows = (["posts", "comments"] as const).flatMap((boardType) => [1, 2, 3].map((rank) => paidBySlot.get(`${boardType}:${rank}`) ?? {
    boardType,
    rank,
    userId: null,
    nickname: null,
    level: null,
    activityCount: 0,
    points: 0,
    paidAt: null,
  }));

  return {
    periodType: type,
    previous: { period: previous, rows: previousRows },
    current: {
      period: current.period,
      rows: [
        ...rewardSlots(current.posts, "posts"),
        ...rewardSlots(current.comments, "comments"),
      ],
    },
  };
}
