import { env } from "cloudflare:workers";
import { memberFromSession } from "../../lib/member-auth";
import { memberLevelProgressPercent, type LevelProgressCounts } from "../../lib/member-level";
import {
  loadMemberLevelProgressRow,
  refreshAutomaticMemberLevelFromProgressRow,
} from "../../lib/member-level-progress";
import { attendancePointsForSettings, loadPointSettings } from "../../lib/point-settings";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const member = await memberFromSession(request);
  if (!member) return Response.json({ error: "로그인이 필요합니다." }, { status: 401 });

  // The full activity aggregate is needed for the guide, so read it exactly
  // once and reuse it for both promotion and progress rendering.
  const [loadedRow, settings] = await Promise.all([
    loadMemberLevelProgressRow(env.DB, member.id),
    loadPointSettings(env.DB),
  ]);
  if (!loadedRow) return Response.json({ error: "회원 정보를 확인할 수 없습니다." }, { status: 404 });
  const row = await refreshAutomaticMemberLevelFromProgressRow(env.DB, loadedRow, settings);

  const current: LevelProgressCounts = {
    attendance: Number(row.attendanceCount) || 0,
    posts: Number(row.postCount) || 0,
    comments: Number(row.commentCount) || 0,
  };
  const levelLocked = Boolean(row.levelLocked);
  const target = levelLocked
    ? null
    : settings.levelRequirements.find((requirement) => requirement.level === row.level + 1) ?? null;
  const remaining = target ? {
    attendance: Math.max(0, target.attendance - current.attendance),
    posts: Math.max(0, target.posts - current.posts),
    comments: Math.max(0, target.comments - current.comments),
  } : null;
  const progressPercent = target ? memberLevelProgressPercent(current, target) : 100;

  return Response.json({
    level: row.level,
    levelLocked,
    current,
    target,
    remaining,
    progressPercent,
    remainingPercent: Math.max(0, Math.round((100 - progressPercent) * 10) / 10),
    attendancePoints: attendancePointsForSettings(row.level, settings),
    nextAttendancePoints: target ? attendancePointsForSettings(target.level, settings) : null,
  });
}
