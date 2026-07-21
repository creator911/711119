import { env } from "cloudflare:workers";
import { ATTENDANCE_STREAK_REWARDS } from "../../lib/attendance-rewards";
import { attendancePointsForLevel, automaticMemberLevel, MAX_AUTOMATIC_MEMBER_LEVEL } from "../../lib/member-level";

const tokenOf = (request: Request) => request.headers.get("cookie")?.match(/(?:^|; )cn_session=([^;]+)/)?.[1];
const dateInKorea = (date = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);

type SessionUser = { id: number; nickname: string; points: number; level: number };
type EarnedRewardRow = { days: number };
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
  const user = await userFromSession(request);

  const calendarRequest = user
    ? env.DB.prepare(`
        SELECT attendance_date AS date, points_awarded AS points
        FROM attendance
        WHERE user_id = ? AND substr(attendance_date, 1, 7) = ?
        ORDER BY attendance_date
      `).bind(user.id, month).all<{ date: string; points: number }>()
    : Promise.resolve({ results: [] as Array<{ date: string; points: number }> });

  const [calendarResult, entriesResult, rankingResult] = await Promise.all([
    calendarRequest,
    env.DB.prepare(`
      SELECT a.id, a.created_at AS createdAt, a.greeting, a.points_awarded AS points,
             u.nickname,
             (SELECT COUNT(*) FROM attendance own WHERE own.user_id = a.user_id) AS totalDays
      FROM attendance a JOIN users u ON u.id = a.user_id
      WHERE a.attendance_date = ?
      ORDER BY a.created_at ASC LIMIT 100
    `).bind(today).all<{ id: number; createdAt: string; greeting: string; points: number; nickname: string; totalDays: number }>(),
    env.DB.prepare(`
      SELECT u.nickname, COUNT(*) AS totalDays, MAX(a.attendance_date) AS latestAttendance
      FROM attendance a JOIN users u ON u.id = a.user_id
      GROUP BY a.user_id, u.nickname
      ORDER BY totalDays DESC, latestAttendance DESC LIMIT 20
    `).all<{ nickname: string; totalDays: number; latestAttendance: string }>(),
  ]);

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
      attendancePoints: attendancePointsForLevel(user.level),
      attended: dates.results.some((item) => item.date === today),
      ...stats,
    };
  }

  return Response.json({
    today,
    month,
    calendar: calendarResult.results,
    entries: entriesResult.results,
    ranking: rankingResult.results,
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
             (SELECT COUNT(*) FROM posts p WHERE p.author_id=u.id AND p.status='published') AS postCount,
             (SELECT COUNT(*) FROM post_comments c WHERE c.user_id=u.id AND c.status='published') AS commentCount,
             (SELECT COUNT(*) FROM attendance a WHERE a.user_id=u.id) AS attendanceCount
      FROM users u
      WHERE u.id=? AND u.status='active'
    `).bind(user.id).first<LevelProgressRow>();
    if (!progress) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });
    const calculatedLevel = Math.min(MAX_AUTOMATIC_MEMBER_LEVEL, automaticMemberLevel(progress.postCount, progress.commentCount, progress.attendanceCount + 1));
    const nextLevel = Boolean(progress.levelLocked) || progress.level >= 10 ? progress.level : Math.max(1, progress.level, calculatedLevel);
    const attendancePoints = attendancePointsForLevel(nextLevel);
    const attendanceStatements = [
      env.DB.prepare("INSERT INTO attendance (user_id,attendance_date,points_awarded,greeting,created_at) VALUES (?,?,?,?,?)").bind(user.id, date, attendancePoints, message, createdAt),
      env.DB.prepare("UPDATE users SET points = points + ? WHERE id = ?").bind(attendancePoints, user.id),
      env.DB.prepare("INSERT INTO point_ledger (user_id,amount,type,status,reference,created_at) VALUES (?,?,'attendance','complete',?,?)").bind(user.id, attendancePoints, message, createdAt),
    ];
    if (nextLevel !== progress.level) {
      attendanceStatements.push(env.DB.prepare("UPDATE users SET level=? WHERE id=? AND level_locked=0 AND level<10").bind(nextLevel, user.id));
    }
    await env.DB.batch(attendanceStatements);
    const dates = await env.DB.prepare("SELECT attendance_date AS date FROM attendance WHERE user_id = ? ORDER BY attendance_date").bind(user.id).all<{ date: string }>();
    const stats = streakStats(dates.results.map((item) => item.date), date);
    let rewardBonusPoints = 0;
    const awardedRewards: Array<{ days: number; points: number }> = [];

    for (const reward of ATTENDANCE_STREAK_REWARDS) {
      if (stats.currentStreak < reward.days) continue;
      const inserted = await env.DB.prepare(`
        INSERT OR IGNORE INTO attendance_streak_rewards(user_id,milestone_days,points,created_at)
        VALUES(?,?,?,?)
      `).bind(user.id, reward.days, reward.points, createdAt).run();
      if ((inserted.meta as { changes?: number }).changes === 0) continue;
      rewardBonusPoints += reward.points;
      awardedRewards.push({ days: reward.days, points: reward.points });
      await env.DB.batch([
        env.DB.prepare("UPDATE users SET points = points + ? WHERE id = ?").bind(reward.points, user.id),
        env.DB.prepare("INSERT INTO point_ledger (user_id,amount,type,status,reference,created_at) VALUES (?,?,'attendance_streak_reward','complete',?,?)").bind(user.id, reward.points, `streak:${reward.days}:${date}`, createdAt),
      ]);
    }

    const updatedUser = await env.DB.prepare("SELECT points,level FROM users WHERE id = ?").bind(user.id).first<{ points: number; level: number }>();
    return Response.json({ ok: true, points: updatedUser?.points ?? attendancePoints, level: updatedUser?.level ?? nextLevel, attendancePoints, rewardBonusPoints, awardedRewards, ...stats });
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (message.includes("UNIQUE")) return Response.json({ error: "오늘 출석은 이미 완료했습니다." }, { status: 409 });
    console.error("Attendance failed", error);
    return Response.json({ error: "출석 처리 중 오류가 발생했습니다. 잠시 후 다시 시도해 주세요." }, { status: 500 });
  }
}
