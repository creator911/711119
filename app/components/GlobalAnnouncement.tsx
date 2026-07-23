"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ANNOUNCEMENT_DELIVERY_LEASE_MS,
  ANNOUNCEMENT_INITIAL_RETRY_DELAYS_MS,
  ANNOUNCEMENT_POLL_BASE_MS,
  ANNOUNCEMENT_POLL_JITTER_MS,
  MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS,
  type ActiveSystemAnnouncement,
  type SystemAnnouncement,
} from "../lib/system-announcements";
import { currentMemberSession, MEMBER_SESSION_EVENT } from "../lib/member-session-client";

type NextResponse = {
  eligible?: boolean;
  announcement?: SystemAnnouncement | null;
  deliveryLeaseToken?: string | null;
  retryAfterMs?: number | null;
};
type ActiveResponse = { announcements?: ActiveSystemAnnouncement[] };
type LoadResult = "success" | "failed" | "skipped";
type AckResult = "success" | "inactive" | "failed";

const AUTO_DISMISS_MS = 5_000;
const AUTO_ACK_RETRY_DELAYS_MS = [2_000, 5_000, 15_000, 30_000, 60_000] as const;
const AUTO_EXCLUSIONS_KEY = "cn:auto-announcement-exclusions";
const isAdminPath = () => window.location.pathname.startsWith("/admin");
const jittered = (base: number, spread: number) => Math.max(1_000, base + Math.round((Math.random() * 2 - 1) * spread));

export default function GlobalAnnouncement() {
  const [eligible, setEligible] = useState<boolean | null>(null);
  const [announcement, setAnnouncement] = useState<SystemAnnouncement | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState("");
  const [deliveryRetryAt, setDeliveryRetryAt] = useState(0);
  const [leaseValidated, setLeaseValidated] = useState(false);
  const [leaseExpiresAt, setLeaseExpiresAt] = useState(0);
  const eligibleRef = useRef<boolean | null>(null);
  const authenticatedRef = useRef(false);
  const loadingNextRef = useRef(false);
  const loadingActiveRef = useRef(false);
  const mountedRef = useRef(true);
  const sessionGenerationRef = useRef(0);
  const announcementRef = useRef<SystemAnnouncement | null>(null);
  const deliveryLeaseTokenRef = useRef("");
  const activeEtagRef = useRef("");
  const autoExcludedIdsRef = useRef<number[]>([]);
  const autoAckJobsRef = useRef(new Map<number, number>());
  const autoAckStatesRef = useRef(new Map<number, "pending" | "success" | "failed">());
  const requiredDialogRef = useRef<HTMLElement>(null);

  const setCurrent = useCallback((next: SystemAnnouncement | null, deliveryLeaseToken = "") => {
    announcementRef.current = next;
    deliveryLeaseTokenRef.current = next ? deliveryLeaseToken : "";
    setLeaseExpiresAt(next && deliveryLeaseToken ? Date.parse(deliveryLeaseToken) + ANNOUNCEMENT_DELIVERY_LEASE_MS : 0);
    setLeaseValidated(Boolean(next && deliveryLeaseToken && document.visibilityState === "visible"));
    setAnnouncement(next);
    setConfirmError("");
  }, []);

  const excludeAutomaticAnnouncement = useCallback((id: number) => {
    const next = [...autoExcludedIdsRef.current.filter((item) => item !== id), id]
      .slice(-MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS);
    autoExcludedIdsRef.current = next;
    try { window.sessionStorage.setItem(AUTO_EXCLUSIONS_KEY, next.join(",")); } catch {}
  }, []);

  const loadNext = useCallback(async (replaceCurrent = false): Promise<LoadResult> => {
    if (!authenticatedRef.current || loadingNextRef.current || isAdminPath() || (announcementRef.current && !replaceCurrent)) return "skipped";
    loadingNextRef.current = true;
    const sessionGeneration = sessionGenerationRef.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const excluded = autoExcludedIdsRef.current;
      const search = new URLSearchParams();
      if (excluded.length) search.set("exclude", excluded.join(","));
      // 자동 알림 ACK가 장시간 실패해 제외 상한에 도달하면 필수 알림만
      // 조회하여 오래된 자동 알림이 순환하며 요청을 계속 만들지 않게 합니다.
      if (excluded.length >= MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS) search.set("requiredOnly", "1");
      const query = search.size ? `?${search.toString()}` : "";
      const response = await fetch(`/api/announcements/next${query}`, { cache: "no-store", signal: controller.signal });
      if (!response.ok) throw new Error("announcement request failed");
      const result = await response.json() as NextResponse;
      if (!mountedRef.current || sessionGeneration !== sessionGenerationRef.current) return "skipped";
      const memberIsEligible = Boolean(result.eligible);
      eligibleRef.current = memberIsEligible;
      setEligible(memberIsEligible);
      const nextAnnouncement = memberIsEligible ? result.announcement ?? null : null;
      setCurrent(
        nextAnnouncement,
        memberIsEligible ? result.deliveryLeaseToken ?? "" : "",
      );
      setDeliveryRetryAt(
        !nextAnnouncement && typeof result.retryAfterMs === "number"
          ? Date.now() + Math.max(250, Math.min(ANNOUNCEMENT_DELIVERY_LEASE_MS, result.retryAfterMs))
          : 0,
      );
      return "success";
    } catch {
      return "failed";
    } finally {
      window.clearTimeout(timeout);
      loadingNextRef.current = false;
    }
  }, [setCurrent]);

  useEffect(() => {
    if (!deliveryRetryAt) return;
    const timer = window.setTimeout(() => {
      setDeliveryRetryAt(0);
      if (!announcementRef.current) void loadNext(true);
    }, Math.max(0, deliveryRetryAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [deliveryRetryAt, loadNext]);

  const acknowledge = useCallback(async (id: number, deliveryLeaseToken: string): Promise<AckResult> => {
    if (!deliveryLeaseToken) return "inactive";
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch(`/api/announcements/${id}/ack`, {
        method: "POST",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deliveryLeaseToken }),
        signal: controller.signal,
      });
      if (response.status === 409 || response.status === 404) return "inactive";
      return response.ok ? "success" : "failed";
    } catch {
      return "failed";
    } finally {
      window.clearTimeout(timeout);
    }
  }, []);

  const startAutomaticAcknowledgement = useCallback((id: number, deliveryLeaseToken: string) => {
    if (autoAckJobsRef.current.has(id)) return;
    if (autoAckJobsRef.current.size >= MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS) return;
    autoAckStatesRef.current.set(id, "pending");
    const sessionGeneration = sessionGenerationRef.current;
    const run = async (attempt: number) => {
      let token = announcementRef.current?.id === id ? deliveryLeaseTokenRef.current : deliveryLeaseToken;
      let result = await acknowledge(id, token);
      if (
        result === "inactive"
        && announcementRef.current?.id === id
        && deliveryLeaseTokenRef.current
        && deliveryLeaseTokenRef.current !== token
      ) {
        token = deliveryLeaseTokenRef.current;
        result = await acknowledge(id, token);
      }
      if (!mountedRef.current || sessionGeneration !== sessionGenerationRef.current) {
        autoAckJobsRef.current.delete(id);
        return;
      }
      if (result === "success") {
        if (announcementRef.current?.id === id) autoAckStatesRef.current.set(id, "success");
        else autoAckStatesRef.current.delete(id);
        autoAckJobsRef.current.delete(id);
        return;
      }
      if (result === "inactive") {
        autoAckStatesRef.current.delete(id);
        autoAckJobsRef.current.delete(id);
        excludeAutomaticAnnouncement(id);
        if (announcementRef.current?.id === id) {
          setCurrent(null);
          void loadNext(true);
        }
        return;
      }
      const delay = AUTO_ACK_RETRY_DELAYS_MS[attempt];
      if (delay === undefined) {
        if (announcementRef.current?.id === id) autoAckStatesRef.current.set(id, "failed");
        else autoAckStatesRef.current.delete(id);
        autoAckJobsRef.current.delete(id);
        return;
      }
      const timer = window.setTimeout(() => void run(attempt + 1), jittered(delay, Math.min(2_000, delay / 5)));
      autoAckJobsRef.current.set(id, timer);
    };
    autoAckJobsRef.current.set(id, 0);
    void run(0);
  }, [acknowledge, excludeAutomaticAnnouncement, loadNext, setCurrent]);

  const checkActiveAnnouncements = useCallback(async (): Promise<boolean> => {
    if (!authenticatedRef.current || isAdminPath()) return true;
    if (loadingActiveRef.current) return false;
    loadingActiveRef.current = true;
    const sessionGeneration = sessionGenerationRef.current;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const response = await fetch("/api/announcements/active", {
        cache: "no-cache",
        headers: activeEtagRef.current ? { "If-None-Match": activeEtagRef.current } : undefined,
        signal: controller.signal,
      });
      if (response.status === 304) return true;
      if (!response.ok) return false;
      const result = await response.json() as ActiveResponse;
      if (!mountedRef.current || sessionGeneration !== sessionGenerationRef.current) return false;
      const nextEtag = response.headers.get("ETag") ?? "";
      const previousEtag = activeEtagRef.current;
      const active = result.announcements ?? [];
      if (eligibleRef.current === false) {
        activeEtagRef.current = nextEtag;
        return true;
      }
      const current = announcementRef.current;
      let needsResolution = false;

      if (current) {
        const matching = active.find((item) => item.id === current.id);
        if (!matching) {
          setCurrent(null);
          needsResolution = true;
        } else if (matching.updatedAt !== current.updatedAt || matching.endsAt !== current.endsAt) {
          needsResolution = true;
        }
      } else if ((!previousEtag && active.length > 0) || (previousEtag && nextEtag !== previousEtag)) {
        needsResolution = true;
      }

      if (needsResolution) {
        const loaded = await loadNext(true);
        if (loaded !== "success" || sessionGeneration !== sessionGenerationRef.current) return false;
      }
      activeEtagRef.current = nextEtag;
      return true;
    } catch {
      return false;
    } finally {
      window.clearTimeout(timeout);
      loadingActiveRef.current = false;
    }
  }, [loadNext, setCurrent]);

  useEffect(() => {
    mountedRef.current = true;
    let retryTimer = 0;
    let generation = 0;
    const ackJobs = autoAckJobsRef.current;
    const ackStates = autoAckStatesRef.current;
    try {
      const stored = window.sessionStorage.getItem(AUTO_EXCLUSIONS_KEY)?.split(",") ?? [];
      autoExcludedIdsRef.current = [...new Set(stored
        .filter((value) => /^\d+$/.test(value) && Number(value) > 0 && Number.isSafeInteger(Number(value)))
        .map(Number))].slice(-MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS);
    } catch { autoExcludedIdsRef.current = []; }

    const clearAutomaticSessionState = () => {
      for (const timer of ackJobs.values()) window.clearTimeout(timer);
      ackJobs.clear();
      ackStates.clear();
      autoExcludedIdsRef.current = [];
      try { window.sessionStorage.removeItem(AUTO_EXCLUSIONS_KEY); } catch {}
    };

    const beginBoundedLoad = () => {
      if (!authenticatedRef.current || isAdminPath()) return;
      const currentGeneration = ++generation;
      window.clearTimeout(retryTimer);
      const run = async (attempt: number) => {
        const success = await checkActiveAnnouncements();
        if (!mountedRef.current || currentGeneration !== generation || success) return;
        const delay = ANNOUNCEMENT_INITIAL_RETRY_DELAYS_MS[attempt];
        if (delay === undefined) return;
        retryTimer = window.setTimeout(() => void run(attempt + 1), jittered(delay, Math.min(1_000, delay / 5)));
      };
      void run(0);
    };

    const sessionChanged = (event: Event) => {
      sessionGenerationRef.current += 1;
      clearAutomaticSessionState();
      const detail = (event as CustomEvent<{ authenticated?: boolean; announcementEligible?: boolean }>).detail;
      const authenticated = Boolean(detail?.authenticated);
      authenticatedRef.current = authenticated;
      if (!authenticated) {
        generation += 1;
        window.clearTimeout(retryTimer);
        eligibleRef.current = false;
        setEligible(false);
        activeEtagRef.current = "";
        setDeliveryRetryAt(0);
        setCurrent(null);
        return;
      }
      const announcementEligible = detail?.announcementEligible !== false;
      eligibleRef.current = announcementEligible;
      setEligible(announcementEligible);
      activeEtagRef.current = "";
      setDeliveryRetryAt(0);
      if (announcementEligible) beginBoundedLoad();
    };
    const visible = () => {
      if (document.visibilityState !== "visible") return;
      if (eligibleRef.current === null) beginBoundedLoad();
      else if (eligibleRef.current === true) void checkActiveAnnouncements();
    };

    window.addEventListener(MEMBER_SESSION_EVENT, sessionChanged);
    document.addEventListener("visibilitychange", visible);
    const initialSession = currentMemberSession();
    if (initialSession) {
      sessionChanged(new CustomEvent(MEMBER_SESSION_EVENT, { detail: initialSession }));
    }
    return () => {
      mountedRef.current = false;
      generation += 1;
      window.clearTimeout(retryTimer);
      for (const timer of ackJobs.values()) window.clearTimeout(timer);
      ackJobs.clear();
      ackStates.clear();
      window.removeEventListener(MEMBER_SESSION_EVENT, sessionChanged);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [checkActiveAnnouncements, loadNext, setCurrent]);

  useEffect(() => {
    if (eligible !== true || isAdminPath()) return;
    let stopped = false;
    let timer = 0;
    let failures = 0;
    const cycle = async () => {
      if (stopped) return;
      if (document.visibilityState !== "visible") {
        timer = window.setTimeout(() => void cycle(), ANNOUNCEMENT_POLL_BASE_MS);
        return;
      }
      const success = await checkActiveAnnouncements();
      failures = success ? 0 : Math.min(failures + 1, 4);
      const base = success ? ANNOUNCEMENT_POLL_BASE_MS : Math.min(300_000, 15_000 * 2 ** failures);
      timer = window.setTimeout(() => void cycle(), jittered(base, ANNOUNCEMENT_POLL_JITTER_MS));
    };
    timer = window.setTimeout(() => void cycle(), jittered(ANNOUNCEMENT_POLL_BASE_MS, ANNOUNCEMENT_POLL_JITTER_MS));
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [checkActiveAnnouncements, eligible]);

  useEffect(() => {
    if (!announcement) return;
    let timer = 0;
    const checkExpiry = () => {
      const remaining = Date.parse(announcement.endsAt) - Date.now();
      if (remaining <= 0) {
        if (announcementRef.current?.id !== announcement.id) return;
        setCurrent(null);
        void loadNext(true);
        return;
      }
      timer = window.setTimeout(checkExpiry, Math.min(remaining + 25, 2_147_000_000));
    };
    timer = window.setTimeout(checkExpiry, 0);
    return () => window.clearTimeout(timer);
  }, [announcement, loadNext, setCurrent]);

  useEffect(() => {
    if (!announcement || !leaseExpiresAt) return;
    const id = announcement.id;
    const timer = window.setTimeout(() => {
      if (announcementRef.current?.id === id && Date.now() >= leaseExpiresAt) setLeaseValidated(false);
    }, Math.max(0, leaseExpiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [announcement, leaseExpiresAt]);

  useEffect(() => {
    if (!announcement || !deliveryLeaseTokenRef.current) return;
    const id = announcement.id;
    let stopped = false;
    let timer = 0;
    let controller: AbortController | null = null;
    let renewalSequence = 0;
    const schedule = (delay: number) => {
      timer = window.setTimeout(() => void renew(), delay);
    };
    const renew = async () => {
      if (stopped || announcementRef.current?.id !== id) return;
      const leaseToken = deliveryLeaseTokenRef.current;
      const requestSequence = ++renewalSequence;
      const requestController = new AbortController();
      controller = requestController;
      const timeout = window.setTimeout(() => requestController.abort(), 8_000);
      try {
        const response = await fetch(`/api/announcements/${id}/lease`, {
          method: "POST",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ leaseToken }),
          signal: requestController.signal,
        });
        if (stopped || requestSequence !== renewalSequence || announcementRef.current?.id !== id) return;
        if (response.status === 404 || response.status === 409) {
          setLeaseValidated(false);
          setCurrent(null);
          void loadNext(true);
          return;
        }
        if (!response.ok) throw new Error("lease renewal failed");
        const result = await response.json() as { leaseToken?: string };
        if (!result.leaseToken || deliveryLeaseTokenRef.current !== leaseToken) return;
        deliveryLeaseTokenRef.current = result.leaseToken;
        setLeaseExpiresAt(Date.parse(result.leaseToken) + ANNOUNCEMENT_DELIVERY_LEASE_MS);
        const visible = document.visibilityState === "visible";
        setLeaseValidated(visible);
        if (visible) schedule(Math.floor(ANNOUNCEMENT_DELIVERY_LEASE_MS / 3));
      } catch {
        if (!stopped && requestSequence === renewalSequence && announcementRef.current?.id === id && document.visibilityState === "visible") schedule(2_000);
      } finally {
        window.clearTimeout(timeout);
        if (controller === requestController) controller = null;
      }
    };
    const visibilityChanged = () => {
      window.clearTimeout(timer);
      if (document.visibilityState !== "visible") {
        renewalSequence += 1;
        setLeaseValidated(false);
        controller?.abort();
        return;
      }
      setLeaseValidated(false);
      void renew();
    };
    document.addEventListener("visibilitychange", visibilityChanged);
    if (document.visibilityState === "visible") schedule(Math.floor(ANNOUNCEMENT_DELIVERY_LEASE_MS / 3));
    return () => {
      stopped = true;
      renewalSequence += 1;
      window.clearTimeout(timer);
      controller?.abort();
      document.removeEventListener("visibilitychange", visibilityChanged);
    };
  }, [announcement, loadNext, setCurrent]);

  useEffect(() => {
    if (!announcement || announcement.requiresConfirmation || !leaseValidated) return;
    const id = announcement.id;
    let firstFrame = 0;
    let secondFrame = 0;
    let dismissTimer = 0;

    // 두 번의 animation frame 뒤에만 기록하여 실제 화면에 그려지기 전 확인 처리되는 일을 막습니다.
    firstFrame = window.requestAnimationFrame(() => {
      secondFrame = window.requestAnimationFrame(() => {
        startAutomaticAcknowledgement(id, deliveryLeaseTokenRef.current);
        dismissTimer = window.setTimeout(() => {
          if (announcementRef.current?.id !== id) return;
          if (autoAckStatesRef.current.get(id) !== "success") excludeAutomaticAnnouncement(id);
          setCurrent(null);
          autoAckStatesRef.current.delete(id);
          void loadNext(true);
        }, AUTO_DISMISS_MS);
      });
    });

    return () => {
      window.cancelAnimationFrame(firstFrame);
      window.cancelAnimationFrame(secondFrame);
      window.clearTimeout(dismissTimer);
    };
  }, [announcement, excludeAutomaticAnnouncement, leaseValidated, loadNext, setCurrent, startAutomaticAcknowledgement]);

  useEffect(() => {
    if (!announcement?.requiresConfirmation || !leaseValidated) return;
    const dialog = requiredDialogRef.current;
    if (!dialog) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusables = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    const frame = window.requestAnimationFrame(() => (focusables()[0] ?? dialog).focus());
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!activeElement || !dialog.contains(activeElement) || !items.includes(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    const recoverFocus = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      (focusables()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", trapFocus);
    document.addEventListener("focusin", recoverFocus);
    return () => {
      window.cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trapFocus);
      document.removeEventListener("focusin", recoverFocus);
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [announcement, leaseValidated]);

  const confirm = async () => {
    if (!announcement || confirming) return;
    setConfirming(true);
    setConfirmError("");
    let token = deliveryLeaseTokenRef.current;
    let result = await acknowledge(announcement.id, token);
    if (
      result === "inactive"
      && announcementRef.current?.id === announcement.id
      && deliveryLeaseTokenRef.current
      && deliveryLeaseTokenRef.current !== token
    ) {
      token = deliveryLeaseTokenRef.current;
      result = await acknowledge(announcement.id, token);
    }
    if (result === "success" || result === "inactive") {
      setCurrent(null);
      void loadNext(true);
    } else {
      setConfirmError("확인 처리가 완료되지 않았습니다. 잠시 후 다시 눌러 주세요.");
    }
    setConfirming(false);
  };

  if (!announcement || !leaseValidated) return null;
  if (!announcement.requiresConfirmation) return <div className="global-announcement-toast" role="status" aria-live="assertive">
    <i />
    <div><b>전체 알림 공지</b><p>{announcement.content}</p></div>
    <span aria-hidden="true" />
  </div>;

  return <div className="global-announcement-backdrop" role="presentation">
    <section ref={requiredDialogRef} tabIndex={-1} className="global-announcement-modal" role="alertdialog" aria-modal="true" aria-labelledby="global-announcement-title" aria-describedby="global-announcement-content">
      <p>NOTICE</p>
      <h2 id="global-announcement-title">전체 알림 공지</h2>
      <div id="global-announcement-content">{announcement.content}</div>
      {confirmError && <small role="alert">{confirmError}</small>}
      <button type="button" disabled={confirming} onClick={() => void confirm()}>{confirming ? "확인 중…" : "확인"}</button>
    </section>
  </div>;
}
