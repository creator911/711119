"use client";

import { useEffect, useRef, useState } from "react";

type ProgressCounts = { attendance: number; posts: number; comments: number };
type ProgressTarget = ProgressCounts & { level: number };
type LevelProgressData = {
  level: number;
  levelLocked: boolean;
  current: ProgressCounts;
  target: ProgressTarget | null;
  remaining: ProgressCounts | null;
  progressPercent: number;
  remainingPercent: number;
  attendancePoints: number;
  nextAttendancePoints: number | null;
};

const percentLabel = (value: number) => Number.isInteger(value) ? String(value) : value.toFixed(1);

export default function LevelProgressModal({ onClose, onLevelChange, onSessionExpired }: {
  onClose: () => void;
  onLevelChange: (level: number) => void;
  onSessionExpired: () => void;
}) {
  const [data, setData] = useState<LevelProgressData | null>(null);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const onLevelChangeRef = useRef(onLevelChange);
  const onSessionExpiredRef = useRef(onSessionExpired);

  useEffect(() => {
    onCloseRef.current = onClose;
    onLevelChangeRef.current = onLevelChange;
    onSessionExpiredRef.current = onSessionExpired;
  }, [onClose, onLevelChange, onSessionExpired]);

  useEffect(() => {
    let active = true;
    fetch("/api/member-level-progress", { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as LevelProgressData & { error?: string };
      if (response.status === 401) {
        onSessionExpiredRef.current();
        throw new Error(result.error ?? "로그인이 만료되었습니다.");
      }
      if (!response.ok) throw new Error(result.error ?? "레벨 정보를 불러오지 못했습니다.");
      if (!active) return;
      setData(result);
      onLevelChangeRef.current(result.level);
    }).catch((reason) => {
      if (active) setError(reason instanceof Error ? reason.message : "레벨 정보를 불러오지 못했습니다.");
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusableElements = () => Array.from(dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )).filter((element) => !element.hasAttribute("hidden"));
    const focusFrame = window.requestAnimationFrame(() => (focusableElements()[0] ?? dialog).focus());

    const handleDialogKeys = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements();
      if (!focusable.length) {
        event.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      if (!activeElement || !dialog.contains(activeElement) || !focusable.includes(activeElement)) {
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
      (focusableElements()[0] ?? dialog).focus();
    };
    document.addEventListener("keydown", handleDialogKeys);
    document.addEventListener("focusin", recoverFocus);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleDialogKeys);
      document.removeEventListener("focusin", recoverFocus);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  const progress = data?.progressPercent ?? 0;
  const statusMessage = data && data.level >= 10
    ? "관리자 레벨입니다."
    : data?.levelLocked
      ? `운영진이 지정한 Lv.${data.level} 고정 레벨입니다.`
      : data && data.level >= 5
        ? "자동 레벨업 최고 단계에 도달했습니다. Lv.6~9는 운영진이 지정합니다."
        : "레벨 정보를 확인하고 있습니다.";

  return <div className="modal-backdrop level-progress-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section ref={dialogRef} className="level-progress-modal" role="dialog" aria-modal="true" aria-labelledby="level-progress-title" tabIndex={-1}>
      <button type="button" className="level-progress-close" onClick={onClose} aria-label="레벨업 안내 닫기">×</button>
      <p className="level-progress-eyebrow">LEVEL GUIDE</p>
      <h2 id="level-progress-title">레벨업 안내</h2>

      {!data && !error ? <div className="level-progress-loading" role="status"><span /><span /><span /><p>현재 레벨 정보를 확인하고 있습니다.</p></div> : error ? <div className="level-progress-error" role="alert"><b>정보를 불러오지 못했습니다.</b><span>{error}</span><button type="button" onClick={onClose}>확인</button></div> : data && <>
        <div className="level-progress-route">
          <strong>Lv.{data.level}</strong>
          {data.target ? <><span>→</span><b>Lv.{data.target.level}</b></> : <small>{data.levelLocked ? "고정" : "현재 단계"}</small>}
        </div>

        {data.target && data.remaining ? <>
          <p className="level-progress-summary">
            Lv.{data.target.level}까지 <b>출석일 {data.remaining.attendance}일</b> · <b>글 {data.remaining.posts}개</b> · <b>댓글 {data.remaining.comments}개</b> 남았습니다.
          </p>
          <div className="level-progress-heading"><span>레벨 진행률</span><b>{percentLabel(progress)}% <small>· {percentLabel(data.remainingPercent)}% 남음</small></b></div>
          <div className="level-progress-track" role="progressbar" aria-label={`Lv.${data.target.level} 레벨 진행률`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
            <span style={{ width: `${progress}%` }} />
          </div>
          <div className="level-progress-stats">
            <ProgressStat label="출석" current={data.current.attendance} target={data.target.attendance} remaining={data.remaining.attendance} unit="일" />
            <ProgressStat label="작성글" current={data.current.posts} target={data.target.posts} remaining={data.remaining.posts} unit="개" />
            <ProgressStat label="댓글" current={data.current.comments} target={data.target.comments} remaining={data.remaining.comments} unit="개" />
          </div>
        </> : <div className="level-progress-complete"><span>Lv.{data.level}</span><b>{statusMessage}</b><p>현재 출석체크 보상은 매일 {data.attendancePoints.toLocaleString()}P입니다.</p></div>}
      </>}
    </section>
  </div>;
}

function ProgressStat({ label, current, target, remaining, unit }: {
  label: string;
  current: number;
  target: number;
  remaining: number;
  unit: string;
}) {
  const complete = remaining === 0;
  return <div className={complete ? "complete" : ""}>
    <span>{label}</span>
    <b>{Math.min(current, target).toLocaleString()}<small> / {target.toLocaleString()}{unit}</small></b>
    <em>{complete ? "달성" : `${remaining.toLocaleString()}${unit} 남음`}</em>
  </div>;
}
