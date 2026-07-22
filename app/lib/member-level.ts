export const MIN_MEMBER_LEVEL = 1;
export const MAX_MEMBER_LEVEL = 10;
export const MAX_AUTOMATIC_MEMBER_LEVEL = 5;

export const MEMBER_LEVEL_REQUIREMENTS = [
  { level: 5, attendance: 150, posts: 100, comments: 300 },
  { level: 4, attendance: 100, posts: 50, comments: 100 },
  { level: 3, attendance: 30, posts: 20, comments: 50 },
  { level: 2, attendance: 5, posts: 5, comments: 10 },
] as const;
export type MemberLevelRequirement = typeof MEMBER_LEVEL_REQUIREMENTS[number] | { level: number; attendance: number; posts: number; comments: number };
export type LevelProgressCounts = { attendance: number; posts: number; comments: number };
export type LevelProgressTarget = LevelProgressCounts & { level: number };

export const isMemberLevel = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= MIN_MEMBER_LEVEL && Number(value) <= MAX_MEMBER_LEVEL;

export const memberLevelLabel = (level: number) => `Lv.${level}`;

export const automaticMemberLevel = (postCount: number, commentCount: number, attendanceCount = 0, requirements: readonly MemberLevelRequirement[] = MEMBER_LEVEL_REQUIREMENTS) =>
  requirements.find((requirement) =>
    attendanceCount >= requirement.attendance &&
    postCount >= requirement.posts &&
    commentCount >= requirement.comments
  )?.level ?? MIN_MEMBER_LEVEL;

export const attendancePointsForLevel = (level: number, basePoints = 50, levelStepPoints = 10) =>
  basePoints + Math.max(0, Math.min(MAX_MEMBER_LEVEL, Math.trunc(level)) - MIN_MEMBER_LEVEL) * levelStepPoints;

const cappedLevelProgressRatio = (current: number, required: number) =>
  required <= 0 ? 1 : Math.min(1, Math.max(0, current) / required);

export function memberLevelProgressPercent(current: LevelProgressCounts, target: LevelProgressTarget) {
  const progress = (
    cappedLevelProgressRatio(current.attendance, target.attendance) +
    cappedLevelProgressRatio(current.posts, target.posts) +
    cappedLevelProgressRatio(current.comments, target.comments)
  ) / 3 * 100;
  return Math.min(100, Math.round(progress * 10) / 10);
}

/**
 * 레벨 권한은 누적되지 않습니다.
 * 모든 회원은 Lv.1 공통 권한을 가지며, Lv.2–9는 자신의 레벨 전용 권한만 추가로 가집니다.
 * Lv.10 관리자는 Lv.1–10의 전체 서비스 권한을 가집니다.
 */
export const memberPermissionLevels = (level: number) =>
  level === MAX_MEMBER_LEVEL ? Array.from({ length: MAX_MEMBER_LEVEL }, (_, index) => index + 1) :
  isMemberLevel(level) && level > MIN_MEMBER_LEVEL ? [MIN_MEMBER_LEVEL, level] : [MIN_MEMBER_LEVEL];

export const hasMemberLevelPermission = (memberLevel: number, permissionLevel: number) =>
  isMemberLevel(memberLevel) && isMemberLevel(permissionLevel) &&
  (memberLevel === MAX_MEMBER_LEVEL || permissionLevel === MIN_MEMBER_LEVEL || permissionLevel === memberLevel);
