import { env } from "cloudflare:workers";
import { AttendanceCommitConflict, commitAttendanceBatch } from "../../lib/attendance-commit";
import { ATTENDANCE_STREAK_REWARDS } from "../../lib/attendance-rewards";
import { MAX_AUTOMATIC_MEMBER_LEVEL } from "../../lib/member-level";
import { attendancePointsForSettings, automaticMemberLevelForSettings, loadPointSettings } from "../../lib/point-settings";
import { isUniqueConstraintError } from "../../lib/database-errors";

const tokenOf = (request: Request) => request.headers.get("cookie")?.match(/(?:^|; )cn_session=([^;]+)/)?.[1];
const dateInKorea = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

type SessionUser = { id: number; nickname: string; points: number; level: number };
type EarnedRewardRow = { days: number };
type StreakLedgerRow = { reference: string | null };
type LevelProgressRow = { level: number; levelLocked: number | boolean; postCount: number; commentCount: number; attendanceCount: number };

async function userFromSession(request: Request) {
  const token = tokenOf(request);
  if (!token) return null;
  return env.DB.prepare(`
    SELECT u.id, u.nickname, u.points, u.level
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ? AND u.status = 'active'
  `).bind(token, new Date().toISOString()).first<SessionUser>();
}

const dayNumber = (value: string) => Math.floor(Date.parse(`${value}T00:00:00Z`) / 86_400_000);

function streakStats(dates: string[], today: string) {
  const uniqueDays = [...new Set(dates)].sort();
  let bestStreak = 0;
  let run = 0;
  let previous = Number.NaN;
  for (const date of uniqueDays) {
    const day = dayNumber(date);
    run = day === previous + 1 ? run + 1 : 1;
    bestStreak = Math.max(bestStreak, run);
    previous = day;
  }

  const attendedDays = new Set(uniqueDays.map(dayNumber));
  let cursor = dayNumber(today);
  if (!attendedDays.has(cursor)) cursor -= 1;
  let currentStreak = 0;
  while (attendedDays.has(cursor)) {
    currentStreak += 1;
    cursor -= 1;
  }
  return { totalDays: uniqueDays.length, currentStreak, bestStreak };
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const today = dateInKorea();
  const requestedMonth = url.searchParams.get("month") ?? today.slice(0, 7);
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : today.slice(0, 7);
  const afterCreatedAt = url.searchParams.get("afterCreatedAt") ?? "";
  const afterIdValue = Number(url.searchParams.get("afterId") ?? "0");
  const hasEntryCursor = Boolean(afterCreatedAt) && Number.isSafeInteger(afterIdValue) && afterIdValue > 0;
  if ((afterCreatedAt || afterIdValue) && !hasEntryCursor) {
    return Response.json({ error: "출석 목록 위치를 확인해 주세요." }, { status: 400 });
  }
  const user = await userFromSession(request);
  const pointSettings = await loadPointSettings(env.DB);

  const calendarRequest = user
    ? env.DB.prepare(`
        SELECT attendance_date AS date, points_awarded AS points
        FROM attendance
        WHERE user_id = ? AND substr(attendance_date, 1, 7) = ?
        ORDER BY attendance_date
      `).bind(user.id, month).all<{ date: string; points: number }>()
    : Promise.resolve({ results: [] as Array<{ date: string; points: number }> });

  const entriesStatement = hasEntryCursor
    ? env.DB.prepare(`
        SELECT a.id, a.created_at AS createdAt, a.greeting, a.points_awarded AS points,
               u.nickname,
               COALESCE(s.attendance_count,0) AS totalDays
        FROM attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN member_activity_stats s ON s.user_id=a.user_id
        WHERE a.attendance_date = ?
          AND (a.created_at > ? OR (a.created_at = ? AND a.id > ?))
        ORDER BY a.created_at ASC,a.id ASC LIMIT 101
      `).bind(today, afterCreatedAt, afterCreatedAt, afterIdValue)
    : env.DB.prepare(`
        SELECT a.id, a.created_at AS createdAt, a.greeting, a.points_awarded AS points,
               u.nickname,
               COALESCE(s.attendance_count,0) AS totalDays
        FROM attendance a
        JOIN users u ON u.id = a.user_id
        LEFT JOIN member_activity_stats s ON s.user_id=a.user_id
        WHERE a.attendance_date = ?
        ORDER BY a.created_at ASC,a.id ASC LIMIT 101
      `).bind(today);

  const [calendarResult, entriesResult, entriesCountRow] = await Promise.all([
    calendarRequest,
    entriesStatement.all<{ id: number; createdAt: string; greeting: string; points: number; nickname: string; totalDays: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS count FROM attendance WHERE attendance_date=?").bind(today).first<{ count: number }>(),
  ]);
  const entryRows = entriesResult.results ?? [];
  const visibleEntries = entryRows.slice(0, 100);
  const lastVisibleEntry = visibleEntries.at(-1);
  const nextEntriesCursor = entryRows.length > 100 && lastVisibleEntry
    ? { createdAt: lastVisibleEntry.createdAt, id: lastVisibleEntry.id }
    : null;

  let userSummary = null;
  let streakRewards = ATTENDANCE_STREAK_REWARDS.map((reward) => ({ ...reward, earned: false }));
  if (user) {
    const [dates, earnedRewards] = await Promise.all([
      env.DB.prepare("SELECT attendance_date AS date FROM attendance WHERE user_id = ? ORDER BY attendance_date").bind(user.id).all<{ date: string }>(),
      env.DB.prepare("SELECT milestone_days AS days FROM attendance_streak_rewards WHERE user_id = ?").bind(user.id).all<EarnedRewardRow>(),
    ]);
    const stats = streakStats(dates.results.map((item) => item.date), today);
    const earnedDays = new Set((earnedRewards.results ?? []).map((item) => item.days));
    streakRewards = ATTENDANCE_STREAK_REWARDS.map((reward) => ({ ...reward, earned: earnedDays.has(reward.days), reachable: stats.currentStreak >= reward.days }));
    userSummary = {
      nickname: user.nickname,
      points: user.points,
      level: user.level,
      attendancePoints: attendancePointsForSettings(user.level, pointSettings),
      attended: dates.results.some((item) => item.date === today),
      ...stats,
    };
  }

  return Response.json({
    today,
    month,
    calendar: calendarResult.results,
    entries: visibleEntries,
    entriesTotal: Number(entriesCountRow?.count ?? 0),
    nextEntriesCursor,
    ranking: [],
    streakRewards,
    user: userSummary,
  });
}

export async function POST(request: Request) {
  try {
    const user = await userFromSession(request);
    if (!user) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const { greeting = "" } = await request.json() as { greeting?: string };
    const message = greeting.trim().replace(/\s+/g, " ");
    if (message.length < 2 || message.length > 50) return Response.json({ error: "출석 인사는 2–50자로 입력해 주세요." }, { status: 400 });

    const date = dateInKorea();
    const existing = await env.DB.prepare("SELECT id FROM attendance WHERE user_id = ? AND attendance_date = ?").bind(user.id, date).first();
    if (existing) return Response.json({ error: "오늘 출석은 이미 완료했습니다." }, { status: 409 });
    const createdAt = new Date().toISOString();
    const progress = await env.DB.prepare(`
      SELECT u.level,u.level_locked AS levelLocked,
             CASE WHEN u.level_locked=0 AND u.level<?
               THEN COALESCE(s.post_count,0) ELSE 0 END AS postCount,
             CASE WHEN u.level_locked=0 AND u.level<?
               THEN COALESCE(s.comment_count,0) ELSE 0 END AS commentCount,
             CASE WHEN u.level_locked=0 AND u.level<?
               THEN COALESCE(s.attendance_count,0) ELSE 0 END AS attendanceCount
      FROM users u
      LEFT JOIN member_activity_stats s ON s.user_id=u.id
      WHERE u.id=? AND u.status='active'
    `).bind(MAX_AUTOMATIC_MEMBER_LEVEL, MAX_AUTOMATIC_MEMBER_LEVEL, MAX_AUTOMATIC_MEMBER_LEVEL, user.id).first<LevelProgressRow>();
    if (!progress) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const pointSettings = await loadPointSettings(env.DB);
    const calculatedLevel = Math.min(MAX_AUTOMATIC_MEMBER_LEVEL, automaticMemberLevelForSettings(progress.postCount, progress.commentCount, progress.attendanceCount + 1, pointSettings));
    const nextLevel = Boolean(progress.levelLocked) || progress.level >= MAX_AUTOMATIC_MEMBER_LEVEL ? progress.level : Math.max(1, progress.level, calculatedLevel);
    const attendancePoints = attendancePointsForSettings(nextLevel, pointSettings);
    const [attendanceDates, streakLedger] = await Promise.all([
      env.DB.prepare("SELECT attendance_date AS date FROM attendance WHERE user_id = ? ORDER BY attendance_date")
        .bind(user.id).all<{ date: string }>(),
      env.DB.prepare("SELECT reference FROM point_ledger WHERE user_id=? AND type='attendance_streak_reward'")
        .bind(user.id).all<StreakLedgerRow>(),
    ]);
    const stats = streakStats([...attendanceDates.results.map((item) => item.date), date], date);
    const paidMilestones = new Set((streakLedger.results ?? []).flatMap(({ reference }) => {
      const matched = reference?.match(/^streak:(\d+)(?::|$)/);
      return matched ? [Number(matched[1])] : [];
    }));
    const eligibleRewards = ATTENDANCE_STREAK_REWARDS.filter((reward) => stats.currentStreak >= reward.days);
    const awardedRewards = eligibleRewards
      .filter((reward) => !paidMilestones.has(reward.days))
      .map(({ days, points }) => ({ days, points }));
    const rewardBonusPoints = awardedRewards.reduce((sum, reward) => sum + reward.points, 0);

    // The member's level can be changed/locked by an administrator after the
    // progress read above. Make the attendance row conditional on that exact
    // state and make every dependent write conditional on this exact row. A
    // concurrent admin change therefore produces a clean retry instead of a
    // stale level reward or a partial points/ledger write.
    const attendanceCommitGuard = `EXISTS(
      SELECT 1 FROM attendance a
      WHERE a.user_id=? AND a.attendance_date=? AND a.created_at=? AND a.points_awarded=?
    )`;
    const attendanceStatements = [
      env.DB.prepare(`
        INSERT INTO attendance (user_id,attendance_date,points_awarded,greeting,created_at)
        SELECT ?,?,?,?,? FROM users u
        WHERE u.id=? AND u.status='active' AND u.level=? AND u.level_locked=?
      `).bind(
        user.id, date, attendancePoints, message, createdAt,
        user.id, progress.level, Number(Boolean(progress.levelLocked)),
      ),
      env.DB.prepare(`
        UPDATE users SET points=points+?
        WHERE id=? AND status='active' AND ${attendanceCommitGuard}
      `).bind(attendancePoints, user.id, user.id, date, createdAt, attendancePoints),
      env.DB.prepare(`
        INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
        SELECT ?,?,'attendance','complete',?,?
        WHERE ${attendanceCommitGuard}
      `).bind(user.id, attendancePoints, message, createdAt, user.id, date, createdAt, attendancePoints),
    ];
    if (nextLevel !== progress.level) {
      attendanceStatements.push(env.DB.prepare(`
        UPDATE users SET level=?
        WHERE id=? AND level=? AND level_locked=0 AND level<?
          AND ${attendanceCommitGuard}
      `).bind(
        nextLevel, user.id, progress.level, MAX_AUTOMATIC_MEMBER_LEVEL,
        user.id, date, createdAt, attendancePoints,
      ));
    }
    // Only milestones without either the current or legacy ledger reference
    // need repair/payment writes. Long-streak members therefore do not issue
    // three no-op statements for every already-paid milestone on each check-in.
    for (const reward of awardedRewards) {
      const reference = `streak:${reward.days}`;
      const legacyReferencePattern = `streak:${reward.days}:%`;
      attendanceStatements.push(env.DB.prepare(`
        INSERT OR IGNORE INTO attendance_streak_rewards(user_id,milestone_days,points,created_at)
        SELECT ?,?,?,? WHERE ${attendanceCommitGuard}
      `).bind(
        user.id, reward.days, reward.points, createdAt,
        user.id, date, createdAt, attendancePoints,
      ));
      attendanceStatements.push(env.DB.prepare(`
        UPDATE users
        SET points=points+(
          SELECT points FROM attendance_streak_rewards
          WHERE user_id=? AND milestone_days=?
        )
        WHERE id=? AND ${attendanceCommitGuard} AND NOT EXISTS(
          SELECT 1 FROM point_ledger
          WHERE user_id=? AND type='attendance_streak_reward'
            AND (reference=? OR reference LIKE ?)
        )
      `).bind(
        user.id, reward.days, user.id,
        user.id, date, createdAt, attendancePoints,
        user.id, reference, legacyReferencePattern,
      ));
      attendanceStatements.push(env.DB.prepare(`
        INSERT INTO point_ledger(user_id,amount,type,status,reference,created_at)
        SELECT user_id,points,'attendance_streak_reward','complete',?,?
        FROM attendance_streak_rewards
        WHERE user_id=? AND milestone_days=? AND ${attendanceCommitGuard} AND NOT EXISTS(
          SELECT 1 FROM point_ledger
          WHERE user_id=? AND type='attendance_streak_reward'
            AND (reference=? OR reference LIKE ?)
        )
      `).bind(
        reference, createdAt, user.id, reward.days,
        user.id, date, createdAt, attendancePoints,
        user.id, reference, legacyReferencePattern,
      ));
    }
    // 출석·기본 포인트·레벨·개근 마커·개근 포인트·원장을 한 트랜잭션으로
    // 처리해 중간 장애가 나도 일부만 반영되거나 영구 미지급되지 않게 합니다.
    await commitAttendanceBatch(env.DB, attendanceStatements, {
      userId: user.id,
      date,
      createdAt,
      points: attendancePoints,
    });

    const updatedUser = await env.DB.prepare("SELECT points,level FROM users WHERE id = ?").bind(user.id).first<{ points: number; level: number }>();
    return Response.json({ ok: true, points: updatedUser?.points ?? attendancePoints, level: updatedUser?.level ?? nextLevel, attendancePoints, rewardBonusPoints, awardedRewards, ...stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (error instanceof AttendanceCommitConflict || message.includes("attendance_member_state_changed")) {
      return Response.json({ error: "회원 정보가 변경되었습니다. 다시 시도해 주세요." }, { status: 409 });
    }
    if (isUniqueConstraintError(error)) return Response.json({ error: "오늘 출석은 이미 완료했습니다." }, { status: 409 });
    console.error("Attendance failed", error);
    return Response.json({ error: "출석 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
