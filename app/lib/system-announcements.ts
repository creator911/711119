export const MAX_ANNOUNCEMENT_CONTENT = 2_000;

export type SystemAnnouncement = {
  id: number;
  content: string;
  requiresConfirmation: boolean;
  startsAt: string;
  endsAt: string;
};

export type AdminSystemAnnouncement = SystemAnnouncement & {
  status: "active" | "cancelled";
  state: "scheduled" | "active" | "ended" | "cancelled";
  createdBy: string;
  createdAt: string;
  deliveredCount: number;
  acknowledgedCount: number;
};

export function announcementState(status: string, startsAt: string, endsAt: string, now = Date.now()): AdminSystemAnnouncement["state"] {
  if (status === "cancelled") return "cancelled";
  if (Date.parse(startsAt) > now) return "scheduled";
  if (Date.parse(endsAt) <= now) return "ended";
  return "active";
}

export function eligibleAnnouncementMember(member: { level: number; role: string } | null) {
  return Boolean(member && member.role === "member" && member.level >= 1 && member.level <= 9);
}

export function normalizeAnnouncementContent(value: unknown) {
  return String(value ?? "").replace(/\r\n?/g, "\n").trim();
}

export function parseAnnouncementWindow(startsAtValue: unknown, endsAtValue: unknown, now = Date.now()) {
  const startsAtMs = Date.parse(String(startsAtValue ?? ""));
  const endsAtMs = Date.parse(String(endsAtValue ?? ""));
  if (!Number.isFinite(startsAtMs) || !Number.isFinite(endsAtMs)) throw new Error("알림 시작일과 종료일을 정확히 입력해 주세요.");
  if (startsAtMs >= endsAtMs) throw new Error("알림 종료 시각은 시작 시각보다 뒤여야 합니다.");
  if (endsAtMs <= now) throw new Error("이미 종료된 기간으로는 알림을 등록할 수 없습니다.");
  return { startsAt: new Date(startsAtMs).toISOString(), endsAt: new Date(endsAtMs).toISOString() };
}
