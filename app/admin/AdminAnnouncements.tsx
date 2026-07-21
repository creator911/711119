"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import type { AdminSystemAnnouncement } from "../lib/system-announcements";

const stateLabels: Record<AdminSystemAnnouncement["state"], string> = { scheduled: "예약", active: "노출 중", ended: "종료", cancelled: "중단" };
const formatDate = (value: string) => new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
const koreaDateTimeValue = (date: Date) => new Date(date.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 16);
const koreaInputToISOString = (value: string) => new Date(`${value}:00+09:00`).toISOString();
const defaultWindow = () => {
  const start = new Date();
  start.setSeconds(0, 0);
  return { startsAt: koreaDateTimeValue(start), endsAt: koreaDateTimeValue(new Date(start.getTime() + 86_400_000)) };
};

export default function AdminAnnouncements() {
  const [initialWindow] = useState(defaultWindow);
  const [announcements, setAnnouncements] = useState<AdminSystemAnnouncement[]>([]);
  const [content, setContent] = useState("");
  const [startsAt, setStartsAt] = useState(initialWindow.startsAt);
  const [endsAt, setEndsAt] = useState(initialWindow.endsAt);
  const [requiresConfirmation, setRequiresConfirmation] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await fetch("/api/admin/announcements", { cache: "no-store" });
      const result = await response.json() as { announcements?: AdminSystemAnnouncement[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "전체 알림 공지를 불러오지 못했습니다.");
      setAnnouncements(result.announcements ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "전체 알림 공지를 불러오지 못했습니다.");
    } finally { setLoading(false); }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/announcements", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, startsAt: koreaInputToISOString(startsAt), endsAt: koreaInputToISOString(endsAt), requiresConfirmation }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "전체 알림 공지를 등록하지 못했습니다.");
      setContent("");
      setMessage("전체 알림 공지를 등록했습니다.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "전체 알림 공지를 등록하지 못했습니다.");
    } finally { setSaving(false); }
  };

  const cancel = async (id: number) => {
    if (!window.confirm("이 알림의 노출을 즉시 중단할까요?")) return;
    setMessage("");
    try {
      const response = await fetch(`/api/admin/announcements/${id}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status: "cancelled" }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "알림을 중단하지 못했습니다.");
      setMessage("전체 알림 노출을 중단했습니다.");
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "알림을 중단하지 못했습니다."); }
  };

  return <section className="announcement-admin-grid">
    <form className="admin-panel announcement-editor" onSubmit={submit}>
      <div className="panel-title"><div><h2>전체 알림 공지 등록</h2><p>Lv.1~9 일반회원에게 지정 기간 중 계정당 한 번만 표시됩니다.</p></div><button type="submit" disabled={saving}>{saving ? "등록 중…" : "알림 등록"}</button></div>
      <div className="announcement-editor-fields">
        <label>알림 시작 시각 (한국시간)<input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required /></label>
        <label>알림 종료 시각 (한국시간)<input type="datetime-local" value={endsAt} onChange={(event) => setEndsAt(event.target.value)} required /></label>
        <label className="announcement-content-field">알림 내용<textarea value={content} onChange={(event) => setContent(event.target.value)} maxLength={2000} rows={8} placeholder="서버 점검, 보상 지급 등 전체 회원에게 안내할 내용을 입력해 주세요." required /><small>{content.length.toLocaleString()} / 2,000</small></label>
      </div>
      <fieldset className="announcement-mode-picker">
        <legend>알림 형태</legend>
        <label className={requiresConfirmation ? "selected" : ""}><input type="radio" name="announcementMode" checked={requiresConfirmation} onChange={() => setRequiresConfirmation(true)} /><span><b>확인 필수</b><small>회원이 확인 버튼을 눌러야 닫히며, 확인 전에는 다시 접속해도 표시됩니다.</small></span></label>
        <label className={!requiresConfirmation ? "selected" : ""}><input type="radio" name="announcementMode" checked={!requiresConfirmation} onChange={() => setRequiresConfirmation(false)} /><span><b>자동 닫힘</b><small>화면에 5초 동안 표시된 뒤 자동으로 사라집니다.</small></span></label>
      </fieldset>
      <p className="announcement-editor-note">관리자 페이지와 Lv.10 계정에는 표시되지 않습니다. 알림 종료 전까지 처음 접속하는 회원도 대상에 포함됩니다.</p>
    </form>

    <section className="admin-panel announcement-history">
      <div className="panel-title"><div><h2>알림 내역</h2><p>예약·노출·확인 현황을 확인하고 필요하면 즉시 중단할 수 있습니다.</p></div><button type="button" onClick={() => void load()}>새로고침</button></div>
      {loading ? <p className="admin-empty">알림 내역을 불러오는 중입니다.</p> : announcements.length ? <div className="announcement-history-list">{announcements.map((item) => <article key={item.id}>
        <header><span className={`announcement-state ${item.state}`}>{stateLabels[item.state]}</span><b>{item.requiresConfirmation ? "확인 필수" : "자동 닫힘"}</b><small>#{item.id}</small></header>
        <p>{item.content}</p>
        <dl><div><dt>노출 기간</dt><dd>{formatDate(item.startsAt)}<br />~ {formatDate(item.endsAt)}</dd></div><div><dt>노출 회원</dt><dd>{item.deliveredCount.toLocaleString()}명</dd></div><div><dt>확인 완료</dt><dd>{item.acknowledgedCount.toLocaleString()}명</dd></div><div><dt>등록자</dt><dd>{item.createdBy}</dd></div></dl>
        {(item.state === "scheduled" || item.state === "active") && <button className="announcement-cancel" type="button" onClick={() => void cancel(item.id)}>노출 중단</button>}
      </article>)}</div> : <p className="admin-empty">등록된 전체 알림 공지가 없습니다.</p>}
    </section>
    {message && <p className="announcement-admin-message" role="status">{message}</p>}
  </section>;
}
