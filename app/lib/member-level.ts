export const MIN_MEMBER_LEVEL = 1;
export const MAX_MEMBER_LEVEL = 10;
export const MAX_AUTOMATIC_MEMBER_LEVEL = 9;

export const MEMBER_LEVEL_REQUIREMENTS = [
  { level: 9, posts: 5000, comments: 50000 },
  { level: 8, posts: 1000, comments: 10000 },
  { level: 7, posts: 500, comments: 3000 },
  { level: 6, posts: 200, comments: 1000 },
  { level: 5, posts: 50, comments: 300 },
  { level: 4, posts: 20, comments: 50 },
  { level: 3, posts: 5, comments: 15 },
  { level: 2, posts: 1, comments: 3 },
] as const;

export const isMemberLevel = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= MIN_MEMBER_LEVEL && Number(value) <= MAX_MEMBER_LEVEL;

export const memberLevelLabel = (level: number) => `Lv.${level}`;

export const automaticMemberLevel = (postCount: number, commentCount: number) =>
  MEMBER_LEVEL_REQUIREMENTS.find((requirement) => postCount >= requirement.posts && commentCount >= requirement.comments)?.level ?? MIN_MEMBER_LEVEL;

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
