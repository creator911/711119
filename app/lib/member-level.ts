export const MIN_MEMBER_LEVEL = 1;
export const MAX_MEMBER_LEVEL = 10;

export const isMemberLevel = (value: unknown): value is number =>
  Number.isInteger(value) && Number(value) >= MIN_MEMBER_LEVEL && Number(value) <= MAX_MEMBER_LEVEL;

export const memberLevelLabel = (level: number) => `Lv.${level}`;

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
