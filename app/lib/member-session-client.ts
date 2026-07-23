export const MEMBER_SESSION_EVENT = "cn:member-session";

export type MemberSessionSnapshot = {
  authenticated: boolean;
  announcementEligible: boolean;
  sequence: number;
};

declare global {
  interface Window {
    __cnMemberSession?: MemberSessionSnapshot;
  }
}

export function publishMemberSession(authenticated: boolean, level?: number) {
  const snapshot = {
    authenticated,
    announcementEligible: authenticated && (level === undefined || (level >= 1 && level <= 9)),
    sequence: (window.__cnMemberSession?.sequence ?? 0) + 1,
  };
  window.__cnMemberSession = snapshot;
  window.dispatchEvent(new CustomEvent(MEMBER_SESSION_EVENT, { detail: snapshot }));
}

export function currentMemberSession() {
  return window.__cnMemberSession ?? null;
}
