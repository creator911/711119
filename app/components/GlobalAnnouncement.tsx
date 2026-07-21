"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { SystemAnnouncement } from "../lib/system-announcements";

type NextResponse = { eligible?: boolean; announcement?: SystemAnnouncement | null };
const SESSION_EVENT = "cn:member-session";

export default function GlobalAnnouncement() {
  const [eligible, setEligible] = useState(false);
  const [announcement, setAnnouncement] = useState<SystemAnnouncement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  const announcementRef = useRef<SystemAnnouncement | null>(null);

  const loadNext = useCallback(async () => {
    if (loadingRef.current || announcementRef.current || window.location.pathname.startsWith("/admin")) return;
    loadingRef.current = true;
    try {
      const response = await fetch("/api/announcements/next", { cache: "no-store" });
      if (!response.ok) return;
      const result = await response.json() as NextResponse;
      if (!mountedRef.current) return;
      setEligible(Boolean(result.eligible));
      announcementRef.current = result.announcement ?? null;
      setAnnouncement(announcementRef.current);
      setConfirmError("");
    } catch {
      // 네트워크가 복구되면 다음 주기나 화면 재활성화 시 다시 확인합니다.
    } finally {
      loadingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const sessionChanged = (event: Event) => {
      const authenticated = Boolean((event as CustomEvent<{ authenticated?: boolean }>).detail?.authenticated);
      if (!authenticated) {
        setEligible(false);
        announcementRef.current = null;
        setAnnouncement(null);
        setConfirmError("");
        return;
      }
      void loadNext();
    };
    const visible = () => { if (document.visibilityState === "visible") void loadNext(); };
    window.addEventListener(SESSION_EVENT, sessionChanged);
    document.addEventListener("visibilitychange", visible);
    const initialTimer = window.setTimeout(() => void loadNext(), 0);
    return () => {
      mountedRef.current = false;
      window.clearTimeout(initialTimer);
      window.removeEventListener(SESSION_EVENT, sessionChanged);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [loadNext]);

  useEffect(() => {
    if (!eligible || announcement || window.location.pathname.startsWith("/admin")) return;
    const timer = window.setInterval(() => void loadNext(), 60_000);
    return () => window.clearInterval(timer);
  }, [announcement, eligible, loadNext]);

  useEffect(() => {
    if (!announcement || announcement.requiresConfirmation) return;
    const timer = window.setTimeout(() => {
      announcementRef.current = null;
      setAnnouncement(null);
      window.setTimeout(() => void loadNext(), 250);
    }, 5_000);
    return () => window.clearTimeout(timer);
  }, [announcement, loadNext]);

  const confirm = async () => {
    if (!announcement || confirming) return;
    setConfirming(true);
    setConfirmError("");
    try {
      const response = await fetch(`/api/announcements/${announcement.id}/ack`, { method: "POST" });
      if (!response.ok) throw new Error("확인 처리가 완료되지 않았습니다. 잠시 후 다시 눌러 주세요.");
      announcementRef.current = null;
      setAnnouncement(null);
      window.setTimeout(() => void loadNext(), 150);
    } catch (error) {
      setConfirmError(error instanceof Error ? error.message : "확인 처리가 완료되지 않았습니다.");
    } finally {
      setConfirming(false);
    }
  };

  if (!announcement) return null;
  if (!announcement.requiresConfirmation) return <div className="global-announcement-toast" role="status" aria-live="assertive">
    <i />
    <div><b>전체 알림 공지</b><p>{announcement.content}</p></div>
    <span aria-hidden="true" />
  </div>;

  return <div className="global-announcement-backdrop" role="presentation">
    <section className="global-announcement-modal" role="alertdialog" aria-modal="true" aria-labelledby="global-announcement-title" aria-describedby="global-announcement-content">
      <p>NOTICE</p>
      <h2 id="global-announcement-title">전체 알림 공지</h2>
      <div id="global-announcement-content">{announcement.content}</div>
      {confirmError && <small role="alert">{confirmError}</small>}
      <button type="button" disabled={confirming} onClick={() => void confirm()}>{confirming ? "확인 중…" : "확인"}</button>
    </section>
  </div>;
}
