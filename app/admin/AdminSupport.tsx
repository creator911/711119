"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { renderRichBody } from "../lib/rich-text";

type Inquiry = {
  id: number;
  title: string;
  body?: string;
  status: "open" | "answered" | "closed";
  staffUnread: number;
  memberUnread: number;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
  userId: number;
  username: string;
  nickname: string;
  points?: number;
};

type Reply = { id: number; senderType: "member" | "staff"; body: string; createdAt: string };

const stamp = (value: string) => new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(value));

const statusText = (status: Inquiry["status"]) => status === "answered" ? "답변완료" : status === "closed" ? "종료" : "접수";

type InquiryKind = "support" | "partner";

export default function AdminSupport({ kind, onChanged }: { kind: InquiryKind; onChanged: () => void }) {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");

  const loadInquiries = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch(`/api/admin/support?kind=${kind}`, { cache: "no-store" });
      const result = await response.json() as { inquiries?: Inquiry[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "문의 목록을 불러오지 못했습니다.");
      setInquiries(result.inquiries ?? []);
      setError("");
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : "문의 목록을 불러오지 못했습니다.");
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [kind]);

  const loadInquiry = useCallback(async (id: number, quiet = false) => {
    try {
      const response = await fetch(`/api/admin/support/${id}?kind=${kind}`, { cache: "no-store" });
      const result = await response.json() as { inquiry?: Inquiry; replies?: Reply[]; error?: string };
      if (!response.ok || !result.inquiry) throw new Error(result.error ?? "문의 내용을 불러오지 못했습니다.");
      setSelectedInquiry(result.inquiry);
      setReplies(result.replies ?? []);
      setInquiries((current) => current.map((item) => item.id === id ? { ...item, staffUnread: 0, status: result.inquiry!.status, replyCount: result.replies?.length ?? item.replyCount } : item));
      setError("");
      if (!quiet) onChanged();
    } catch (caught) {
      if (!quiet) setError(caught instanceof Error ? caught.message : "문의 내용을 불러오지 못했습니다.");
    }
  }, [kind, onChanged]);

  useEffect(() => {
    const firstLoad = window.setTimeout(() => void loadInquiries(), 0);
    const timer = window.setInterval(() => void loadInquiries(true), 8000);
    return () => { window.clearTimeout(firstLoad); window.clearInterval(timer); };
  }, [loadInquiries]);

  useEffect(() => {
    if (selectedId === null) return;
    const firstLoad = window.setTimeout(() => void loadInquiry(selectedId), 0);
    return () => window.clearTimeout(firstLoad);
  }, [loadInquiry, selectedId]);

  const filteredInquiries = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? inquiries.filter((item) => `${item.title} ${item.username} ${item.nickname}`.toLowerCase().includes(keyword)) : inquiries;
  }, [inquiries, query]);

  const sendReply = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = draft.trim();
    if (!selectedId || !body || sending) return;
    setSending(true);
    try {
      const response = await fetch(`/api/admin/support/${selectedId}?kind=${kind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const result = await response.json() as Reply & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "답변을 저장하지 못했습니다.");
      setDraft("");
      setReplies((current) => [...current, result]);
      setSelectedInquiry((current) => current ? { ...current, status: "answered", replyCount: current.replyCount + 1, updatedAt: result.createdAt } : current);
      await loadInquiries(true);
      onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "답변을 저장하지 못했습니다.");
    } finally {
      setSending(false);
    }
  };

  const changeStatus = async (status: Inquiry["status"]) => {
    if (!selectedId) return;
    const response = await fetch(`/api/admin/support/${selectedId}?kind=${kind}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status }),
    });
    const result = await response.json() as { error?: string };
    if (!response.ok) return setError(result.error ?? "문의 상태를 변경하지 못했습니다.");
    setSelectedInquiry((current) => current ? { ...current, status } : current);
    await loadInquiries(true);
    onChanged();
  };

  const labels = kind === "partner"
    ? { title: "제휴문의", desc: "회원이 제휴문의에 남긴 1:1 문의를 제목 목록으로 확인하고 답변합니다." }
    : { title: "고객상담", desc: "회원이 고객센터에 남긴 1:1 문의를 제목 목록으로 확인하고 답변합니다." };

  return <section className="admin-panel inquiry-admin">
    <div className="panel-title">
      <div><h2>{labels.title}</h2><p>{labels.desc}</p></div>
      <div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="제목·아이디·닉네임 검색" /><button onClick={() => void loadInquiries()}>새로고침</button></div>
    </div>
    <div className="inquiry-admin-list">
      <div className="inquiry-admin-head"><span>상태</span><b>제목</b><span>회원</span><span>댓글</span><span>일시</span></div>
      {loading ? <p className="admin-empty">문의 목록을 불러오는 중입니다.</p> : filteredInquiries.length ? filteredInquiries.map((inquiry) => <article className={selectedId === inquiry.id ? "active" : ""} key={inquiry.id}>
        <button type="button" onClick={() => setSelectedId(selectedId === inquiry.id ? null : inquiry.id)}>
          <span>{inquiry.staffUnread > 0 ? "새문의" : statusText(inquiry.status)}</span>
          <b>{inquiry.title}</b>
          <span>{inquiry.nickname}<small>@{inquiry.username}</small></span>
          <span>{inquiry.replyCount}</span>
          <time>{stamp(inquiry.createdAt)}</time>
        </button>
        {selectedId === inquiry.id && selectedInquiry && <div className="inquiry-admin-detail">
          <div className="inquiry-admin-body"><strong>{selectedInquiry.title}</strong><div className="rich-body" dangerouslySetInnerHTML={{ __html: renderRichBody(selectedInquiry.body ?? "") }} /></div>
          <div className="inquiry-admin-replies">
            {replies.map((reply) => <div className={reply.senderType} key={reply.id}><b>{reply.senderType === "staff" ? "운영자" : selectedInquiry.nickname}</b><p>{reply.body}</p><time>{stamp(reply.createdAt)}</time></div>)}
            {!replies.length && <p className="admin-empty">아직 등록된 답변이 없습니다.</p>}
          </div>
          <form className="inquiry-admin-reply" onSubmit={sendReply}><textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={1000} placeholder="답변 댓글을 입력하세요." /><div><button type="button" onClick={() => void changeStatus(selectedInquiry.status === "closed" ? "open" : "closed")}>{selectedInquiry.status === "closed" ? "다시 열기" : "종료"}</button><button type="submit" disabled={sending || !draft.trim()}>{sending ? "저장 중…" : "댓글 등록"}</button></div></form>
        </div>}
      </article>) : <p className="admin-empty">아직 접수된 문의가 없습니다.</p>}
      {error && <p className="support-admin-error">{error}</p>}
    </div>
  </section>;
}
