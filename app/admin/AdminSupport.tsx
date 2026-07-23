"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import SupportReplyComposer from "../components/SupportReplyComposer";
import { visiblePageNumbers } from "../lib/board-pagination";
import { renderRichBody } from "../lib/rich-text";
import { adminSupportPrefixSearch, MAX_ADMIN_SUPPORT_SEARCH_CHARACTERS } from "../lib/admin-support-search";

type Inquiry = {
  id: number;
  title: string;
  body?: string;
  status: "open" | "answered" | "closed";
  staffUnread: number;
  memberUnread: number;
  replyCount: number;
  latestReplyId?: number;
  createdAt: string;
  updatedAt: string;
  userId: number;
  username: string;
  nickname: string;
  points?: number;
};

type Reply = { id: number; senderType: "member" | "staff"; body: string; createdAt: string };
type InquiryKind = "support" | "partner";
type ListResponse = { inquiries?: Inquiry[]; total?: number; page?: number; pageSize?: number; totalPages?: number; error?: string };
type AdminSupportProps = { kind: InquiryKind; onChanged: () => void };

const PAGE_SIZE = 30;
const stamp = (value: string) => new Intl.DateTimeFormat("ko-KR", {
  timeZone: "Asia/Seoul",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(value));

const statusText = (status: Inquiry["status"]) => status === "answered" ? "답변 완료" : status === "closed" ? "종료" : "접수";

export default function AdminSupport(props: AdminSupportProps) {
  return <AdminSupportView key={props.kind} {...props} />;
}

function AdminSupportView({ kind, onChanged }: AdminSupportProps) {
  const [inquiries, setInquiries] = useState<Inquiry[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [selectedInquiry, setSelectedInquiry] = useState<Inquiry | null>(null);
  const [loadedId, setLoadedId] = useState<number | null>(null);
  const [replies, setReplies] = useState<Reply[]>([]);
  const [previousReplyCursor, setPreviousReplyCursor] = useState<number | null>(null);
  const [loadingOlderReplies, setLoadingOlderReplies] = useState(false);
  const [searchInput, setSearchInput] = useState("");
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [reloadToken, setReloadToken] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const onChangedRef = useRef(onChanged);
  const mountedRef = useRef(true);
  const selectedIdRef = useRef<number | null>(null);
  const listSequenceRef = useRef(0);
  const detailSequenceRef = useRef(0);
  const listAbortRef = useRef<AbortController | null>(null);
  const detailAbortRef = useRef<AbortController | null>(null);
  const replyPageAbortRef = useRef<AbortController | null>(null);
  const replyPageSequenceRef = useRef(0);
  const viewedAbortRef = useRef<AbortController | null>(null);
  const viewedSequenceRef = useRef(0);
  const pageRef = useRef(page);
  const queryRef = useRef(query);

  useEffect(() => { onChangedRef.current = onChanged; }, [onChanged]);
  useEffect(() => { pageRef.current = page; }, [page]);
  useEffect(() => { queryRef.current = query; }, [query]);

  const resetReplyPagination = useCallback(() => {
    replyPageSequenceRef.current += 1;
    replyPageAbortRef.current?.abort();
    replyPageAbortRef.current = null;
    setPreviousReplyCursor(null);
    setLoadingOlderReplies(false);
  }, []);

  const clearSelectedInquiry = useCallback(() => {
    selectedIdRef.current = null;
    setSelectedId(null);
    setSelectedInquiry(null);
    setLoadedId(null);
    setReplies([]);
    setDetailLoading(false);
    resetReplyPagination();
    detailSequenceRef.current += 1;
    viewedSequenceRef.current += 1;
    detailAbortRef.current?.abort();
    viewedAbortRef.current?.abort();
  }, [resetReplyPagination]);

  const loadInquiries = useCallback(async (requestedPage: number, requestedQuery: string, quiet = false) => {
    const requestKind = kind;
    const sequence = ++listSequenceRef.current;
    listAbortRef.current?.abort();
    const controller = new AbortController();
    listAbortRef.current = controller;
    if (!quiet) setLoading(true);
    try {
      const search = new URLSearchParams({ kind: requestKind, page: String(requestedPage), pageSize: String(PAGE_SIZE) });
      if (requestedQuery) search.set("q", requestedQuery);
      const response = await fetch(`/api/admin/support?${search.toString()}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as ListResponse;
      if (!response.ok) throw new Error(result.error ?? "문의 목록을 불러오지 못했습니다.");
      if (sequence !== listSequenceRef.current || !mountedRef.current) return false;
      const resolvedPage = Math.max(1, Number(result.page ?? requestedPage));
      setInquiries(result.inquiries ?? []);
      setTotal(Math.max(0, Number(result.total ?? 0)));
      setTotalPages(Math.max(1, Number(result.totalPages ?? 1)));
      if (resolvedPage !== requestedPage) {
        pageRef.current = resolvedPage;
        setPage(resolvedPage);
      }
      setError("");
      return true;
    } catch (caught) {
      if (controller.signal.aborted || sequence !== listSequenceRef.current) return false;
      if (!quiet) setError(caught instanceof Error ? caught.message : "문의 목록을 불러오지 못했습니다.");
      return false;
    } finally {
      if (sequence === listSequenceRef.current) {
        if (listAbortRef.current === controller) listAbortRef.current = null;
        setLoading(false);
      }
    }
  }, [kind]);

  const loadInquiry = useCallback(async (id: number, quiet = false) => {
    const requestKind = kind;
    const sequence = ++detailSequenceRef.current;
    detailAbortRef.current?.abort();
    const controller = new AbortController();
    detailAbortRef.current = controller;
    if (!quiet) setDetailLoading(true);
    try {
      const response = await fetch(`/api/admin/support/${id}?kind=${requestKind}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as { inquiry?: Inquiry; replies?: Reply[]; previousReplyCursor?: number | null; error?: string };
      if (!response.ok || !result.inquiry) throw new Error(result.error ?? "문의 내용을 불러오지 못했습니다.");
      if (sequence !== detailSequenceRef.current || !mountedRef.current || selectedIdRef.current !== id) return false;
      const nextReplies = result.replies ?? [];
      setSelectedInquiry(result.inquiry);
      setLoadedId(id);
      if (quiet) {
        setReplies((current) => {
          const repliesById = new Map(current.map((reply) => [reply.id, reply]));
          for (const reply of nextReplies) repliesById.set(reply.id, reply);
          return [...repliesById.values()].sort((left, right) => left.id - right.id);
        });
      } else {
        setReplies(nextReplies);
        resetReplyPagination();
        setPreviousReplyCursor(result.previousReplyCursor ?? null);
      }
      setInquiries((current) => current.map((item) => item.id === id ? { ...item, status: result.inquiry!.status, replyCount: result.inquiry!.replyCount, updatedAt: result.inquiry!.updatedAt } : item));
      setError("");
      return true;
    } catch (caught) {
      if (controller.signal.aborted || sequence !== detailSequenceRef.current) return false;
      if (!quiet && selectedIdRef.current === id) {
        clearSelectedInquiry();
        setError(caught instanceof Error ? caught.message : "문의 내용을 불러오지 못했습니다.");
      }
      return false;
    } finally {
      if (sequence === detailSequenceRef.current) {
        if (detailAbortRef.current === controller) detailAbortRef.current = null;
        setDetailLoading(false);
      }
    }
  }, [clearSelectedInquiry, kind, resetReplyPagination]);

  const loadOlderReplies = async () => {
    const id = selectedIdRef.current;
    const cursor = previousReplyCursor;
    if (!id || !cursor || loadingOlderReplies) return;
    const requestKind = kind;
    const sequence = ++replyPageSequenceRef.current;
    replyPageAbortRef.current?.abort();
    const controller = new AbortController();
    replyPageAbortRef.current = controller;
    setLoadingOlderReplies(true);
    try {
      const search = new URLSearchParams({ kind: requestKind, beforeReplyId: String(cursor) });
      const response = await fetch(`/api/admin/support/${id}?${search.toString()}`, { cache: "no-store", signal: controller.signal });
      const result = await response.json() as { replies?: Reply[]; previousReplyCursor?: number | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? "이전 답변을 불러오지 못했습니다.");
      if (sequence !== replyPageSequenceRef.current || !mountedRef.current || selectedIdRef.current !== id) return;
      setReplies((current) => {
        const currentIds = new Set(current.map((reply) => reply.id));
        return [...(result.replies ?? []).filter((reply) => !currentIds.has(reply.id)), ...current];
      });
      setPreviousReplyCursor(result.previousReplyCursor ?? null);
      setError("");
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError") && sequence === replyPageSequenceRef.current && selectedIdRef.current === id) {
        setError(caught instanceof Error ? caught.message : "이전 답변을 불러오지 못했습니다.");
      }
    } finally {
      if (sequence === replyPageSequenceRef.current) {
        if (replyPageAbortRef.current === controller) replyPageAbortRef.current = null;
        setLoadingOlderReplies(false);
      }
    }
  };

  useEffect(() => {
    const id = loadedId;
    if (!id || selectedInquiry?.id !== id || selectedIdRef.current !== id || selectedInquiry.staffUnread <= 0 || !Number.isSafeInteger(selectedInquiry.latestReplyId)) return;
    const requestKind = kind;
    const sequence = ++viewedSequenceRef.current;
    viewedAbortRef.current?.abort();
    const controller = new AbortController();
    viewedAbortRef.current = controller;
    const frame = window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const response = await fetch(`/api/admin/support/${id}?kind=${requestKind}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ viewed: true, viewedThroughReplyId: selectedInquiry.latestReplyId }),
            signal: controller.signal,
          });
          const result = await response.json() as { viewed?: boolean; error?: string };
          if (!response.ok) throw new Error(result.error ?? "문의 확인 상태를 저장하지 못했습니다.");
          if (!mountedRef.current || sequence !== viewedSequenceRef.current || selectedIdRef.current !== id) return;
          if (result.viewed !== true) {
            void loadInquiry(id, true);
            return;
          }
          setInquiries((current) => current.map((item) => item.id === id ? { ...item, staffUnread: 0 } : item));
          setSelectedInquiry((current) => current?.id === id ? { ...current, staffUnread: 0 } : current);
          onChangedRef.current();
        } catch (caught) {
          if (!(caught instanceof DOMException && caught.name === "AbortError") && mountedRef.current && sequence === viewedSequenceRef.current && selectedIdRef.current === id) {
            setError(caught instanceof Error ? caught.message : "문의 확인 상태를 저장하지 못했습니다.");
          }
        } finally {
          if (sequence === viewedSequenceRef.current && viewedAbortRef.current === controller) viewedAbortRef.current = null;
        }
      })();
    });
    return () => {
      window.cancelAnimationFrame(frame);
      if (viewedAbortRef.current === controller) viewedAbortRef.current = null;
      controller.abort();
    };
  }, [kind, loadInquiry, loadedId, selectedInquiry?.id, selectedInquiry?.latestReplyId, selectedInquiry?.staffUnread]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const nextQuery = searchInput.trim().replace(/\s+/g, " ");
      if (nextQuery !== queryRef.current && selectedIdRef.current !== null) clearSelectedInquiry();
      pageRef.current = 1;
      queryRef.current = nextQuery;
      setPage(1);
      setQuery(nextQuery);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [clearSelectedInquiry, searchInput]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadInquiries(page, query), 0);
    const polling = window.setInterval(() => {
      const refreshPage = pageRef.current;
      const refreshQuery = queryRef.current;
      const openInquiryId = selectedIdRef.current;
      void Promise.all([
        loadInquiries(refreshPage, refreshQuery, true),
        openInquiryId ? loadInquiry(openInquiryId, true) : Promise.resolve(false),
      ]);
    }, 30000);
    return () => {
      window.clearTimeout(timer);
      window.clearInterval(polling);
      listSequenceRef.current += 1;
      listAbortRef.current?.abort();
    };
  }, [kind, loadInquiries, loadInquiry, page, query, reloadToken]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      listSequenceRef.current += 1;
      detailSequenceRef.current += 1;
      viewedSequenceRef.current += 1;
      replyPageSequenceRef.current += 1;
      listAbortRef.current?.abort();
      detailAbortRef.current?.abort();
      viewedAbortRef.current?.abort();
      replyPageAbortRef.current?.abort();
    };
  }, []);

  const openInquiry = (id: number) => {
    if (selectedIdRef.current === id) {
      clearSelectedInquiry();
      return;
    }
    clearSelectedInquiry();
    selectedIdRef.current = id;
    setSelectedId(id);
    setSelectedInquiry(null);
    setLoadedId(null);
    void loadInquiry(id);
  };

  const goToPage = (nextPage: number) => {
    if (loading || nextPage === page || nextPage < 1 || nextPage > totalPages) return;
    clearSelectedInquiry();
    pageRef.current = nextPage;
    setPage(nextPage);
  };

  const sendReply = async (body: string): Promise<boolean> => {
    const targetId = selectedIdRef.current;
    const targetKind = kind;
    if (!targetId || !body.trim() || sending || detailLoading) return false;
    setSending(true);
    try {
      const response = await fetch(`/api/admin/support/${targetId}?kind=${targetKind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const result = await response.json() as Reply & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "답변을 저장하지 못했습니다.");
      if (!mountedRef.current) return true;
      setInquiries((current) => current.map((item) => item.id === targetId ? { ...item, status: "answered", replyCount: item.replyCount + 1, updatedAt: result.createdAt } : item));
      if (selectedIdRef.current === targetId) {
        setReplies((current) => [...current, result]);
        setSelectedInquiry((current) => current?.id === targetId ? { ...current, status: "answered", replyCount: current.replyCount + 1, updatedAt: result.createdAt } : current);
      }
      onChangedRef.current();
      const refreshPage = pageRef.current;
      const refreshQuery = queryRef.current;
      await Promise.all([
        loadInquiries(refreshPage, refreshQuery, true),
        selectedIdRef.current === targetId ? loadInquiry(targetId, true) : Promise.resolve(false),
      ]);
      return true;
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "답변을 저장하지 못했습니다.");
      return false;
    } finally {
      if (mountedRef.current) setSending(false);
    }
  };

  const changeStatus = async (status: Inquiry["status"]) => {
    const targetId = selectedIdRef.current;
    const targetKind = kind;
    if (!targetId) return;
    try {
      const response = await fetch(`/api/admin/support/${targetId}?kind=${targetKind}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "문의 상태를 변경하지 못했습니다.");
      if (!mountedRef.current) return;
      setInquiries((current) => current.map((item) => item.id === targetId ? { ...item, status } : item));
      if (selectedIdRef.current === targetId) {
        setSelectedInquiry((current) => current?.id === targetId ? { ...current, status } : current);
      }
      onChangedRef.current();
      await loadInquiries(pageRef.current, queryRef.current, true);
    } catch (caught) {
      if (mountedRef.current) setError(caught instanceof Error ? caught.message : "문의 상태를 변경하지 못했습니다.");
    }
  };

  const pageNumbers = useMemo(() => visiblePageNumbers(page, totalPages), [page, totalPages]);
  const labels = kind === "partner"
    ? { title: "제휴문의", desc: "회원의 제휴문의와 운영팀의 1:1 답변을 제목 목록에서 확인하고 처리합니다." }
    : { title: "고객상담", desc: "회원의 고객센터 1:1 문의를 제목 목록에서 확인하고 답변합니다." };

  return <section className="admin-panel inquiry-admin">
    <div className="panel-title">
      <div><h2>{labels.title}</h2><p>{labels.desc}</p></div>
      <div><input value={searchInput} maxLength={MAX_ADMIN_SUPPORT_SEARCH_CHARACTERS} onChange={(event) => {
        const next = event.target.value;
        if (!adminSupportPrefixSearch(next)) {
          setError("검색어는 한글 포함 UTF-8 기준 80바이트 이내로 입력해 주세요.");
          return;
        }
        setSearchInput(next);
      }} placeholder="제목·아이디·닉네임 앞부분 검색" aria-label={`${labels.title} 앞부분 검색`} title="제목, 아이디 또는 닉네임의 시작 부분을 검색합니다." /><button type="button" onClick={() => setReloadToken((token) => token + 1)}>새로고침</button></div>
    </div>
    <div className="inquiry-admin-list">
      <div className="inquiry-admin-head"><span>상태</span><b>제목</b><span>회원</span><span>댓글</span><span>일시</span></div>
      {loading ? <p className="admin-empty">문의 목록을 불러오는 중입니다.</p> : inquiries.length ? inquiries.map((inquiry) => <article className={selectedId === inquiry.id ? "active" : ""} key={inquiry.id}>
        <button type="button" onClick={() => openInquiry(inquiry.id)}>
          <span>{inquiry.staffUnread > 0 ? `새문의 ${inquiry.staffUnread}` : statusText(inquiry.status)}</span>
          <b>{inquiry.title}</b>
          <span>{inquiry.nickname}<small>@{inquiry.username}</small></span>
          <span>{inquiry.replyCount}</span>
          <time>{stamp(inquiry.updatedAt || inquiry.createdAt)}</time>
        </button>
        {selectedId === inquiry.id && <div className="inquiry-admin-detail">
          {detailLoading || !selectedInquiry || selectedInquiry.id !== inquiry.id ? <p className="admin-empty">문의 내용을 불러오는 중입니다.</p> : <>
            <div className="inquiry-admin-body"><strong>{selectedInquiry.title}</strong><div className="rich-body" dangerouslySetInnerHTML={{ __html: renderRichBody(selectedInquiry.body ?? "") }} /></div>
            <div className="inquiry-admin-replies">
              {previousReplyCursor && <button type="button" className="inquiry-admin-replies-more" onClick={() => void loadOlderReplies()} disabled={loadingOlderReplies}>{loadingOlderReplies ? "이전 답변 불러오는 중…" : "이전 답변 더보기"}</button>}
              {selectedInquiry.replyCount > replies.length && <p className="inquiry-admin-reply-summary">전체 {selectedInquiry.replyCount.toLocaleString()}개 중 최근 {replies.length.toLocaleString()}개 답변을 표시합니다.</p>}
              {replies.map((reply) => <div className={reply.senderType} key={reply.id}><b>{reply.senderType === "staff" ? "운영자" : selectedInquiry.nickname}</b><div className="rich-body support-reply-body" dangerouslySetInnerHTML={{ __html: renderRichBody(reply.body) }} /><time>{stamp(reply.createdAt)}</time></div>)}
              {!replies.length && <p className="admin-empty">아직 등록된 답변이 없습니다.</p>}
            </div>
            <SupportReplyComposer
              key={selectedInquiry.id}
              variant="admin"
              submitting={sending}
              onSend={sendReply}
              placeholder="답변 내용을 입력해 주세요."
              submitLabel="답변 등록"
              secondaryAction={<button type="button" onClick={() => void changeStatus(selectedInquiry.status === "closed" ? "open" : "closed")}>{selectedInquiry.status === "closed" ? "다시 열기" : "종료"}</button>}
            />
          </>}
        </div>}
      </article>) : <p className="admin-empty">{query ? "검색 결과가 없습니다." : "아직 접수된 문의가 없습니다."}</p>}
      {error && <p className="support-admin-error" role="alert">{error}</p>}
    </div>
    <div className="inquiry-admin-footer">
      <span>{query ? "전체 데이터 앞부분 검색 · " : ""}전체 {total.toLocaleString()}건 · {page.toLocaleString()} / {totalPages.toLocaleString()}페이지</span>
      <div className="forum-pagination" aria-label={`${labels.title} 페이지`}>
        <button type="button" aria-label="이전 페이지" disabled={loading || page <= 1} onClick={() => goToPage(page - 1)}>‹</button>
        {pageNumbers.map((pageNumber) => <button type="button" className={pageNumber === page ? "active" : ""} aria-current={pageNumber === page ? "page" : undefined} disabled={loading} key={pageNumber} onClick={() => goToPage(pageNumber)}>{pageNumber}</button>)}
        <button type="button" aria-label="다음 페이지" disabled={loading || page >= totalPages} onClick={() => goToPage(page + 1)}>›</button>
      </div>
    </div>
  </section>;
}
