"use client";

import Link from "next/link";
import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import AdminShop from "./AdminShop";
import AdminSupport from "./AdminSupport";
import RichTextEditor from "../components/RichTextEditor";
import { normalizeAdminMemberFlags } from "../lib/admin-member-flags";
import { vendorRegionGroups } from "../lib/vendor-regions";

type Member = {
  id: number;
  username: string;
  nickname: string;
  signupIp: string;
  firstLoginIp: string | null;
  points: number;
  level: number;
  isDirector: boolean;
  isPartner: boolean;
  status: "active" | "suspended";
  createdAt: string;
};

type Post = { id: number; category: string; title: string; author: string; views: number; likes: number; isNotice: boolean; status: string; createdAt: string };
type BlockedIp = { ip: string; reason: string; createdAt: string };
type DirectorRegion = { userId: number; region: string; district: string };
type DirectorMember = Pick<Member, "id" | "username" | "nickname" | "level" | "status">;
type AffiliateMember = Pick<Member, "id" | "username" | "nickname" | "level" | "points" | "status" | "isDirector" | "isPartner" | "createdAt">;
type FeaturedVendorPermission = { userId: number; slot: number };
type AdminTab = "posts" | "events" | "notices" | "shop" | "members" | "security" | "support" | "partner" | "directors" | "affiliates";
type Operator = { username: string; role: "owner" | "level10"; level: 10; canManageAdmins: boolean };
type Overview = {
  operator: Operator;
  stats: { totalMembers: number; activeMembers: number; todayMembers: number; todayPosts: number; todayAttendance: number; supportUnread: number; partnerUnread: number; shopLowStockProducts: number };
  members: Member[];
  posts: Post[];
  blockedIps: BlockedIp[];
};

const emptyOverview: Overview = { operator: { username: "", role: "owner", level: 10, canManageAdmins: false }, stats: { totalMembers: 0, activeMembers: 0, todayMembers: 0, todayPosts: 0, todayAttendance: 0, supportUnread: 0, partnerUnread: 0, shopLowStockProducts: 0 }, members: [], posts: [], blockedIps: [] };
const formatDate = (value: string) => value ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "2-digit", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const adminTitles: Record<AdminTab, string> = { posts: "최신글 리스트", events: "이벤트 관리", notices: "공지 관리", shop: "상점 수정", members: "회원정보 관리", security: "보안·IP 관리", support: "고객센터 상담", partner: "제휴문의 상담", directors: "실장", affiliates: "제휴회원" };

export default function AdminConsole() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [tab, setTab] = useState<AdminTab>("posts");
  const [toast, setToast] = useState("");
  const [overview, setOverview] = useState<Overview>(emptyOverview);
  const [memberRows, setMemberRows] = useState<Member[]>([]);
  const [dirtyMemberIds, setDirtyMemberIds] = useState<number[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [newIp, setNewIp] = useState("");
  const [newIpReason, setNewIpReason] = useState("관리자 차단");
  const [publishingKind, setPublishingKind] = useState<"events" | "notices" | null>(null);
  const [directorRegions, setDirectorRegions] = useState<Record<number, DirectorRegion[]>>({});
  const [directorMembers, setDirectorMembers] = useState<DirectorMember[]>([]);
  const [directorRegionsLoading, setDirectorRegionsLoading] = useState(false);
  const [expandedDirectorId, setExpandedDirectorId] = useState<number | null>(null);
  const [dirtyDirectorIds, setDirtyDirectorIds] = useState<number[]>([]);
  const [savingDirectorId, setSavingDirectorId] = useState<number | null>(null);
  const [affiliateMembers, setAffiliateMembers] = useState<AffiliateMember[]>([]);
  const [affiliateSlots, setAffiliateSlots] = useState<Record<number, number[]>>({});
  const [affiliatePermissionsLoading, setAffiliatePermissionsLoading] = useState(false);
  const [dirtyAffiliateIds, setDirtyAffiliateIds] = useState<number[]>([]);
  const [savingAffiliateId, setSavingAffiliateId] = useState<number | null>(null);

  const notify = (message: string) => { setToast(message); window.setTimeout(() => setToast(""), 2600); };

  const loadOverview = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const response = await fetch("/api/admin/overview", { cache: "no-store" });
      if (response.status === 401) { setSignedIn(false); return false; }
      const result = await response.json() as Overview & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "관리자 정보를 불러오지 못했습니다.");
      const normalizedMembers = result.members.map(normalizeAdminMemberFlags);
      setOverview({ ...result, members: normalizedMembers });
      setMemberRows(normalizedMembers);
      setDirtyMemberIds([]);
      setSignedIn(true);
      return true;
    } catch (error) {
      setSignedIn(false);
      notify(error instanceof Error ? error.message : "관리자 정보를 불러오지 못했습니다.");
      return false;
    } finally {
      if (!quiet) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadOverview(), 0);
    return () => window.clearTimeout(timer);
  }, [loadOverview]);

  useEffect(() => {
    if (!signedIn || tab !== "directors") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setDirectorRegionsLoading(true);
      void fetch("/api/admin/director-regions", { cache: "no-store" })
        .then(async (response) => {
          const result = await response.json() as { directors?: DirectorMember[]; assignments?: DirectorRegion[]; error?: string };
          if (!response.ok) throw new Error(result.error ?? "실장 담당지역을 불러오지 못했습니다.");
          if (cancelled) return;
          const grouped = (result.assignments ?? []).reduce<Record<number, DirectorRegion[]>>((rows, assignment) => {
            (rows[assignment.userId] ??= []).push(assignment);
            return rows;
          }, {});
          setDirectorMembers(result.directors ?? []);
          setDirectorRegions(grouped);
          setDirtyDirectorIds([]);
        })
        .catch((error) => {
          if (cancelled) return;
          setToast(error instanceof Error ? error.message : "실장 담당지역을 불러오지 못했습니다.");
          window.setTimeout(() => setToast(""), 2600);
        })
        .finally(() => {
          if (!cancelled) setDirectorRegionsLoading(false);
        });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, tab]);

  useEffect(() => {
    if (!signedIn || tab !== "affiliates") return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setAffiliatePermissionsLoading(true);
      void fetch("/api/admin/featured-vendor-permissions", { cache: "no-store" })
        .then(async (response) => {
          const result = await response.json() as { affiliates?: AffiliateMember[]; assignments?: FeaturedVendorPermission[]; error?: string };
          if (!response.ok) throw new Error(result.error ?? "제휴회원 슬롯 권한을 불러오지 못했습니다.");
          if (cancelled) return;
          const grouped = (result.assignments ?? []).reduce<Record<number, number[]>>((rows, permission) => {
            (rows[permission.userId] ??= []).push(permission.slot);
            return rows;
          }, {});
          setAffiliateMembers(result.affiliates ?? []);
          setAffiliateSlots(grouped);
          setDirtyAffiliateIds([]);
        })
        .catch((error) => {
          if (cancelled) return;
          setToast(error instanceof Error ? error.message : "제휴회원 슬롯 권한을 불러오지 못했습니다.");
          window.setTimeout(() => setToast(""), 2600);
        })
        .finally(() => {
          if (!cancelled) setAffiliatePermissionsLoading(false);
        });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [signedIn, tab]);

  const login = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    try {
      const data = new FormData(event.currentTarget);
      const response = await fetch("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(data)) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "관리자 로그인에 실패했습니다.");
      await loadOverview();
    } catch (error) {
      notify(error instanceof Error ? error.message : "관리자 로그인에 실패했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const logout = async () => {
    await fetch("/api/admin/logout", { method: "POST" });
    setOverview(emptyOverview);
    setMemberRows([]);
    setDirectorMembers([]);
    setDirectorRegions({});
    setDirtyDirectorIds([]);
    setExpandedDirectorId(null);
    setAffiliateMembers([]);
    setAffiliateSlots({});
    setDirtyAffiliateIds([]);
    setSignedIn(false);
  };

  const changeMember = (id: number, changes: Partial<Member>) => {
    setMemberRows((rows) => rows.map((row) => row.id === id ? { ...row, ...changes } : row));
    setDirtyMemberIds((ids) => ids.includes(id) ? ids : [...ids, id]);
  };

  const saveMembers = async () => {
    if (!dirtyMemberIds.length || submitting) return notify("변경된 회원 정보가 없습니다.");
    setSubmitting(true);
    try {
      const changed = memberRows.filter((member) => dirtyMemberIds.includes(member.id));
      const responses = await Promise.all(changed.map((member) => fetch("/api/admin/members", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id: member.id, nickname: member.nickname, points: member.points, level: member.level, status: member.status, isDirector: member.isDirector, isPartner: member.isPartner }) })));
      const failed = responses.find((response) => !response.ok);
      if (failed) throw new Error(((await failed.json()) as { error?: string }).error ?? "회원 정보 저장에 실패했습니다.");
      setDirtyMemberIds([]);
      notify("회원 정보를 저장했습니다.");
      await loadOverview();
    } catch (error) {
      notify(error instanceof Error ? error.message : "회원 정보 저장에 실패했습니다.");
      await loadOverview(true);
    } finally {
      setSubmitting(false);
    }
  };

  const addBlockedIp = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const response = await fetch("/api/admin/blocked-ips", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip: newIp, reason: newIpReason }) });
    const result = await response.json() as { error?: string };
    if (!response.ok) return notify(result.error ?? "IP 차단에 실패했습니다.");
    setNewIp("");
    notify("차단 IP를 저장했습니다.");
    await loadOverview();
  };

  const removeBlockedIp = async (ip: string) => {
    const response = await fetch("/api/admin/blocked-ips", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ip }) });
    if (!response.ok) return notify("IP 차단 해제에 실패했습니다.");
    notify(`${ip} 차단을 해제했습니다.`);
    await loadOverview();
  };

  const publishAdminPost = async (payload: { category: "notices" | "events"; title: string; body: string }, mode: "events" | "notices") => {
    if (publishingKind) return false;
    setPublishingKind(mode);
    try {
      const response = await fetch(mode === "events" ? "/api/admin/events" : "/api/admin/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "게시글 등록에 실패했습니다.");
      notify(mode === "events" ? "이벤트를 게시했습니다." : "공지를 게시했습니다.");
      await loadOverview(true);
      return true;
    } catch (error) {
      notify(error instanceof Error ? error.message : "게시글 등록에 실패했습니다.");
      return false;
    } finally {
      setPublishingKind(null);
    }
  };

  const markDirectorRegionDirty = (userId: number) => {
    setDirtyDirectorIds((ids) => ids.includes(userId) ? ids : [...ids, userId]);
  };

  const toggleDirectorRegion = (userId: number, region: string, district: string) => {
    setDirectorRegions((current) => {
      const selected = current[userId] ?? [];
      const exists = selected.some((item) => item.region === region && item.district === district);
      return {
        ...current,
        [userId]: exists
          ? selected.filter((item) => item.region !== region || item.district !== district)
          : [...selected, { userId, region, district }],
      };
    });
    markDirectorRegionDirty(userId);
  };

  const toggleDirectorRegionGroup = (userId: number, region: string, districts: readonly string[]) => {
    setDirectorRegions((current) => {
      const selected = current[userId] ?? [];
      const allSelected = districts.every((district) => selected.some((item) => item.region === region && item.district === district));
      const withoutGroup = selected.filter((item) => item.region !== region);
      return {
        ...current,
        [userId]: allSelected
          ? withoutGroup
          : [...withoutGroup, ...districts.map((district) => ({ userId, region, district }))],
      };
    });
    markDirectorRegionDirty(userId);
  };

  const saveDirectorRegions = async (userId: number) => {
    if (savingDirectorId !== null) return;
    setSavingDirectorId(userId);
    try {
      const regions = (directorRegions[userId] ?? []).map(({ region, district }) => ({ region, district }));
      const response = await fetch("/api/admin/director-regions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, regions }),
      });
      const result = await response.json() as { assignments?: Array<{ region: string; district: string }>; error?: string };
      if (!response.ok) throw new Error(result.error ?? "실장 담당지역 저장에 실패했습니다.");
      setDirectorRegions((current) => ({
        ...current,
        [userId]: (result.assignments ?? regions).map((item) => ({ userId, ...item })),
      }));
      setDirtyDirectorIds((ids) => ids.filter((id) => id !== userId));
      notify("실장 담당지역을 저장했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "실장 담당지역 저장에 실패했습니다.");
    } finally {
      setSavingDirectorId(null);
    }
  };

  const toggleAffiliateSlot = (userId: number, slotNumber: number) => {
    setAffiliateSlots((current) => {
      const selected = current[userId] ?? [];
      const next = selected.includes(slotNumber)
        ? selected.filter((slot) => slot !== slotNumber)
        : [...selected, slotNumber].sort((left, right) => left - right);
      return { ...current, [userId]: next };
    });
    setDirtyAffiliateIds((ids) => ids.includes(userId) ? ids : [...ids, userId]);
  };

  const saveAffiliateSlots = async (userId: number) => {
    if (savingAffiliateId !== null) return;
    setSavingAffiliateId(userId);
    try {
      const slots = affiliateSlots[userId] ?? [];
      const response = await fetch("/api/admin/featured-vendor-permissions", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, slots }),
      });
      const result = await response.json() as { slots?: number[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "제휴회원 슬롯 권한을 저장하지 못했습니다.");
      setAffiliateSlots((current) => ({ ...current, [userId]: result.slots ?? slots }));
      setDirtyAffiliateIds((ids) => ids.filter((id) => id !== userId));
      notify("제휴회원 슬롯 권한을 저장했습니다.");
    } catch (error) {
      notify(error instanceof Error ? error.message : "제휴회원 슬롯 권한을 저장하지 못했습니다.");
    } finally {
      setSavingAffiliateId(null);
    }
  };

  const filteredMembers = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    return keyword ? memberRows.filter((member) => `${member.username} ${member.nickname}`.toLowerCase().includes(keyword)) : memberRows;
  }, [memberRows, query]);
  const eventPosts = overview.posts.filter((post) => post.category === "events");
  const noticePosts = overview.posts.filter((post) => post.category === "notices");

  if (signedIn === null || loading && signedIn !== false) return <main className="admin-login admin-loading"><span className="admin-loader" aria-label="불러오는 중" /></main>;

  if (!signedIn) return <main className="admin-login"><form onSubmit={login} aria-label="보안 로그인"><input name="username" autoComplete="username" placeholder="아이디" aria-label="아이디" required /><input name="password" type="password" autoComplete="current-password" placeholder="비밀번호" aria-label="비밀번호" required /><button type="submit" disabled={submitting}>{submitting ? "확인 중…" : "보안 로그인"}</button></form>{toast && <div className="admin-toast" role="status">{toast}</div>}</main>;

  return <div className="admin-shell">
    <aside className="admin-side"><div className="admin-brand"><span>CN</span><b>운영 콘솔</b></div><nav><button className={tab === "posts" ? "active" : ""} onClick={() => setTab("posts")}><span>01</span>최신글</button><button className={tab === "events" ? "active" : ""} onClick={() => setTab("events")}><span>02</span>이벤트 관리</button><button className={tab === "notices" ? "active" : ""} onClick={() => setTab("notices")}><span>03</span>공지 관리</button><button className={tab === "shop" ? "active" : ""} onClick={() => setTab("shop")}><span>04</span>상점 수정{overview.stats.shopLowStockProducts > 0 && <em title="자동상품 지급 이미지 확인 필요">{overview.stats.shopLowStockProducts > 99 ? "99+" : overview.stats.shopLowStockProducts}</em>}</button><button className={tab === "members" ? "active" : ""} onClick={() => setTab("members")}><span>05</span>회원 관리</button><button className={tab === "security" ? "active" : ""} onClick={() => setTab("security")}><span>06</span>보안·IP</button><button className={tab === "support" ? "active" : ""} onClick={() => setTab("support")}><span>07</span>고객센터{overview.stats.supportUnread > 0 && <em>{overview.stats.supportUnread > 99 ? "99+" : overview.stats.supportUnread}</em>}</button><button className={tab === "partner" ? "active" : ""} onClick={() => setTab("partner")}><span>08</span>제휴문의{overview.stats.partnerUnread > 0 && <em>{overview.stats.partnerUnread > 99 ? "99+" : overview.stats.partnerUnread}</em>}</button><button className={tab === "directors" ? "active" : ""} onClick={() => setTab("directors")}><span>09</span>실장</button><button className={tab === "affiliates" ? "active" : ""} onClick={() => setTab("affiliates")}><span>10</span>제휴회원</button></nav><div className="admin-user"><div>10</div><p><b>{overview.operator.username}</b><small>{overview.operator.role === "owner" ? "OWNER · Lv.10" : "ADMIN · Lv.10"}</small></p></div></aside>
    <main className="admin-main">
      <header><div><p>CONTROL CENTER</p><h1>{adminTitles[tab]}</h1></div><div className="admin-top-actions"><span><i /> 시스템 정상</span><Link href="/">사이트 보기 ↗</Link><button onClick={logout}>로그아웃</button></div></header>
      <section className="admin-stats"><article><span>오늘 가입</span><b>{overview.stats.todayMembers.toLocaleString()}</b><small>오늘 00시 기준</small></article><article><span>활성 회원</span><b>{overview.stats.activeMembers.toLocaleString()}</b><small>전체 {overview.stats.totalMembers.toLocaleString()}명</small></article><article><span>오늘 게시글</span><b>{overview.stats.todayPosts.toLocaleString()}</b><small>실제 등록 데이터</small></article><article><span>오늘 출석</span><b>{overview.stats.todayAttendance.toLocaleString()}</b><small>회원당 50P 자동 적립</small></article></section>
      {tab === "posts" && <section className="admin-panel"><div className="panel-title"><div><h2>최신 등록글</h2><p>실제 데이터베이스에 저장된 게시글만 표시됩니다.</p></div><button onClick={() => void loadOverview()}>새로고침</button></div><div className="admin-table posts-table"><div className="admin-tr head"><span>테마</span><b>제목</b><span>작성자</span><span>작성 시각</span><span>상태</span><span>조회·추천</span></div>{overview.posts.length ? overview.posts.map((post) => <div className="admin-tr" key={post.id}><span><em>{post.category}</em></span><b>{post.title}</b><span>{post.author}</span><span>{formatDate(post.createdAt)}</span><span><i className="green-dot" /> {post.status === "published" ? "공개" : "숨김"}</span><span>{post.views.toLocaleString()} · {post.likes.toLocaleString()}</span></div>) : <p className="admin-empty">아직 데이터베이스에 등록된 게시글이 없습니다.</p>}</div></section>}
      {tab === "events" && <section className="event-admin-grid"><AdminBoardEditor mode="events" submitting={publishingKind === "events"} onPublish={(payload) => publishAdminPost(payload, "events")} /><AdminPostList title="최근 이벤트" description="관리자가 등록한 이벤트 게시글입니다." posts={eventPosts} onRefresh={() => void loadOverview()} /></section>}
      {tab === "notices" && <section className="event-admin-grid"><AdminBoardEditor mode="notices" submitting={publishingKind === "notices"} onPublish={(payload) => publishAdminPost(payload, "notices")} /><AdminPostList title="최근 공지" description="공지사항 대메뉴에 노출되는 운영 공지글입니다." posts={noticePosts} onRefresh={() => void loadOverview()} /></section>}
      {tab === "shop" && <AdminShop onChanged={() => void loadOverview(true)} />}
      {tab === "members" && <section className="admin-panel">
        <div className="panel-title"><div><h2>회원 개인정보·레벨 관리</h2><p>{overview.operator.canManageAdmins ? "오너 계정은 회원을 Lv.10 관리자로 지정하거나 해제할 수 있습니다." : "Lv.10 관리자는 다른 관리자의 지정·해제를 제외한 회원 관리 권한을 가집니다."}</p></div><div><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="아이디·닉네임 검색" /><button onClick={saveMembers} disabled={submitting}>{submitting ? "저장 중…" : `변경 저장${dirtyMemberIds.length ? ` (${dirtyMemberIds.length})` : ""}`}</button></div></div>
        <div className="admin-table member-table">
          <div className="admin-tr head"><b>아이디</b><span>닉네임</span><span>레벨</span><span>가입 IP</span><span>포인트</span><span>가입일</span><span>상태</span><span>관리</span><span>실장</span><span>제휴</span></div>
          {filteredMembers.length ? filteredMembers.map((member) => {
            const protectedAdmin = !overview.operator.canManageAdmins && member.level === 10;
            return <div className={`admin-tr ${protectedAdmin ? "protected-admin" : ""}`} key={member.id}>
              <b>{member.username}</b>
              <span><input value={member.nickname} maxLength={12} disabled={protectedAdmin} onChange={(event) => changeMember(member.id, { nickname: event.target.value })} /></span>
              <span className="level-control"><b>Lv.</b><input type="number" min="1" max={overview.operator.canManageAdmins ? 10 : 9} value={member.level} disabled={protectedAdmin} aria-label={`${member.nickname} 레벨`} onChange={(event) => changeMember(member.id, { level: Math.max(1, Math.min(overview.operator.canManageAdmins ? 10 : 9, Number(event.target.value))) })} /></span>
              <span title={member.firstLoginIp ? `최초 로그인 ${member.firstLoginIp}` : "로그인 기록 없음"}>{member.signupIp}</span>
              <span><input type="number" min="0" max="1000000000" value={member.points} disabled={protectedAdmin} onChange={(event) => changeMember(member.id, { points: Number(event.target.value) })} /></span>
              <span>{formatDate(member.createdAt)}</span>
              <span className={member.status === "suspended" ? "red-text" : "green-text"}>{member.status === "suspended" ? "정지" : "정상"}</span>
              <span>{protectedAdmin ? <em className="owner-only">오너 전용</em> : <button className={member.status === "suspended" ? "" : "danger"} onClick={() => changeMember(member.id, { status: member.status === "suspended" ? "active" : "suspended" })}>{member.status === "suspended" ? "정지 해제" : "이용 정지"}</button>}</span>
              <span><select className={member.isDirector ? "director-selected" : ""} value={member.isDirector ? "director" : "member"} aria-label={`${member.nickname} 실장 상태`} onChange={(event) => changeMember(member.id, event.target.value === "director" ? { isDirector: true } : { isDirector: false, isPartner: false })}><option value="member">일반</option><option value="director">실장</option></select></span>
              <span><select className={member.isPartner ? "partner-selected" : ""} value={member.isPartner ? "partner" : "member"} disabled={!member.isDirector && !member.isPartner} aria-label={`${member.nickname} 제휴 상태`} title={!member.isDirector ? "실장 지정 후 제휴회원으로 변경할 수 있습니다." : undefined} onChange={(event) => changeMember(member.id, { isPartner: event.target.value === "partner" })}><option value="member">일반</option><option value="partner">제휴</option></select></span>
            </div>;
          }) : <p className="admin-empty">조건에 맞는 회원이 없습니다.</p>}
        </div>
      </section>}
      {tab === "security" && <section className="admin-security"><article><div className="panel-title"><div><h2>가입 차단 IP</h2><p>관리자가 직접 등록한 IP만 가입을 차단합니다.</p></div></div><form className="ip-form" onSubmit={addBlockedIp}><input value={newIp} onChange={(event) => setNewIp(event.target.value)} placeholder="예: 203.0.113.10" aria-label="차단할 IP" required /><input value={newIpReason} onChange={(event) => setNewIpReason(event.target.value)} placeholder="차단 사유" aria-label="차단 사유" required /><button type="submit">차단 추가</button></form><div className="ip-list">{overview.blockedIps.length ? overview.blockedIps.map((item) => <div key={item.ip}><code>{item.ip}</code><span>{item.reason}</span><small>{formatDate(item.createdAt)}</small><button onClick={() => void removeBlockedIp(item.ip)}>해제</button></div>) : <p className="admin-empty">현재 차단된 IP가 없습니다.</p>}</div></article><article className="architecture-card"><p>SERVER AUTH</p><h2>관리자 인증 분리 운영</h2><div className="architecture"><div><b>www</b><span>일반 서비스</span></div><i>→</i><div><b>/admin</b><span>운영 화면</span></div><i>→</i><div><b>Auth</b><span>서버 검증</span></div></div><ul><li>관리자 비밀번호를 브라우저 코드에서 제거</li><li>서버 서명 세션과 소유자 전용 접근 적용</li><li>정식 런칭 전 별도 관리자 호스트 분리 권장</li></ul></article></section>}
      {tab === "support" && <AdminSupport kind="support" onChanged={() => void loadOverview(true)} />}
      {tab === "partner" && <AdminSupport kind="partner" onChanged={() => void loadOverview(true)} />}
      {tab === "directors" && <section className="admin-panel">
        <div className="panel-title"><div><h2>실장 담당지역</h2><p>실장을 선택해 글을 등록할 수 있는 상세지역을 여러 곳 배정해 주세요.</p></div><strong className="designation-count">총 {directorMembers.length.toLocaleString()}명</strong></div>
        <div className="director-region-list">
          {directorMembers.length ? directorMembers.map((member) => {
            const isExpanded = expandedDirectorId === member.id;
            const assigned = directorRegions[member.id] ?? [];
            const isDirty = dirtyDirectorIds.includes(member.id);
            return <article className={`director-region-card${isExpanded ? " expanded" : ""}`} key={member.id}>
              <button className="director-region-summary" type="button" aria-expanded={isExpanded} aria-controls={`director-regions-${member.id}`} onClick={() => setExpandedDirectorId(isExpanded ? null : member.id)}>
                <b>{member.username}</b>
                <span>{member.nickname}</span>
                <span>Lv.{member.level}</span>
                <span>{assigned.length.toLocaleString()}곳 배정</span>
                <span className={member.status === "suspended" ? "red-text" : "green-text"}>{member.status === "suspended" ? "정지" : "정상"}</span>
                <em>{isExpanded ? "접기 −" : "지역 설정 +"}</em>
              </button>
              {isExpanded && <div className="director-region-editor" id={`director-regions-${member.id}`}>
                <div className="director-region-toolbar">
                  <div><b>{member.nickname} 담당지역</b><span>상세지역은 여러 개 선택할 수 있으며 저장 후 해당 실장의 글쓰기 화면에만 활성화됩니다.</span></div>
                  <button type="button" disabled={!isDirty || savingDirectorId !== null || member.status !== "active"} onClick={() => void saveDirectorRegions(member.id)}>{savingDirectorId === member.id ? "저장 중…" : isDirty ? `변경 저장 (${assigned.length})` : `저장됨 (${assigned.length})`}</button>
                </div>
                {member.status !== "active" && <p className="director-region-warning">정지된 실장은 지역을 변경할 수 없습니다. 회원 관리에서 정상 상태로 변경한 뒤 저장해 주세요.</p>}
                {directorRegionsLoading ? <p className="admin-empty">담당지역을 불러오는 중입니다.</p> : <div className="director-region-groups">
                  {vendorRegionGroups.filter((group) => group.label !== "전체").map((group) => {
                    const allSelected = group.districts.every((district) => assigned.some((item) => item.region === group.label && item.district === district));
                    const selectedCount = group.districts.filter((district) => assigned.some((item) => item.region === group.label && item.district === district)).length;
                    return <fieldset key={group.label} disabled={member.status !== "active" || savingDirectorId !== null}>
                      <legend>{group.label}<small>{selectedCount}/{group.districts.length}</small></legend>
                      <button className="director-group-toggle" type="button" onClick={() => toggleDirectorRegionGroup(member.id, group.label, group.districts)}>{allSelected ? "전체 해제" : "전체 선택"}</button>
                      <div className="director-region-checks">
                        {group.districts.map((district) => {
                          const checked = assigned.some((item) => item.region === group.label && item.district === district);
                          return <label className={checked ? "checked" : ""} key={`${group.label}-${district}`}><input type="checkbox" checked={checked} onChange={() => toggleDirectorRegion(member.id, group.label, district)} /><span>{district}</span></label>;
                        })}
                      </div>
                    </fieldset>;
                  })}
                </div>}
              </div>}
            </article>;
          }) : <p className="admin-empty">아직 실장으로 지정된 회원이 없습니다.</p>}
        </div>
      </section>}
      {tab === "affiliates" && <section className="admin-panel">
        <div className="panel-title"><div><h2>제휴회원 추천업체 권한</h2><p>활성 상태의 실장·제휴회원에게 수정할 추천업체 슬롯을 여러 개 배정할 수 있습니다.</p></div><strong className="designation-count">총 {affiliateMembers.length.toLocaleString()}명</strong></div>
        <div className="admin-table affiliate-permission-table">
          <div className="admin-tr head"><b>아이디</b><span>닉네임</span><span>레벨</span><span>상태</span><span>추천업체 슬롯 권한</span><span>저장</span></div>
          {affiliatePermissionsLoading ? <p className="admin-empty">제휴회원 슬롯 권한을 불러오는 중입니다.</p> : affiliateMembers.length ? affiliateMembers.map((member) => {
            const selectedSlots = affiliateSlots[member.id] ?? [];
            const eligible = member.status === "active" && member.isDirector && member.isPartner;
            const isDirty = dirtyAffiliateIds.includes(member.id);
            return <div className={`admin-tr${eligible ? "" : " affiliate-ineligible"}`} key={member.id}>
              <b>{member.username}</b>
              <span>{member.nickname}</span>
              <span>Lv.{member.level}</span>
              <span className={member.status === "suspended" || !member.isDirector ? "red-text" : "green-text"}>{member.status === "suspended" ? "정지" : !member.isDirector ? "실장 필요" : "정상"}</span>
              <span className="affiliate-slot-checks">
                {[1, 2, 3, 4].map((slotNumber) => <label className={selectedSlots.includes(slotNumber) ? "checked" : ""} key={slotNumber}><input type="checkbox" checked={selectedSlots.includes(slotNumber)} disabled={!eligible || savingAffiliateId !== null} onChange={() => toggleAffiliateSlot(member.id, slotNumber)} /><span>{slotNumber}번</span></label>)}
              </span>
              <span className="affiliate-slot-save"><button type="button" disabled={!eligible || !isDirty || savingAffiliateId !== null} onClick={() => void saveAffiliateSlots(member.id)}>{savingAffiliateId === member.id ? "저장 중…" : isDirty ? "변경 저장" : `저장됨 (${selectedSlots.length})`}</button></span>
            </div>;
          }) : <p className="admin-empty">아직 제휴로 지정된 회원이 없습니다.</p>}
        </div>
      </section>}
    </main>{toast && <div className="admin-toast" role="status">{toast}</div>}
  </div>;
}

type AdminPostPayload = { category: "notices" | "events"; title: string; body: string };

function AdminBoardEditor({ mode, submitting, onPublish }: { mode: "events" | "notices"; submitting: boolean; onPublish: (payload: AdminPostPayload) => Promise<boolean> }) {
  const [body, setBody] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || editorBusy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    const category = mode === "events" ? "events" : "notices";
    const saved = await onPublish({ category, title: String(data.get("title") ?? ""), body });
    if (saved) { form.reset(); setBody(""); }
  };
  return <form className="admin-panel admin-board-editor" onSubmit={submit}>
    <div className="panel-title"><div><h2>{mode === "events" ? "새 이벤트 작성" : "새 공지 작성"}</h2><p>{mode === "events" ? "등록 즉시 이벤트 게시판에 공개됩니다." : "선택한 게시판 상단에 공지로 고정됩니다."}</p></div></div>
    <div className="admin-editor-fields">
      <label>{mode === "events" ? "이벤트 제목" : "공지 제목"}<input name="title" required minLength={2} maxLength={80} placeholder="제목을 입력하세요." /></label>
      <RichTextEditor name="body" value={body} onChange={setBody} onBusyChange={setEditorBusy} compact placeholder={mode === "events" ? "혜택, 기간, 참여 방법 등 자세한 내용을 입력하세요." : "공지 내용을 입력하세요."} />
      <div className="admin-editor-note"><span>개인정보 노출과 불법 정보가 포함되지 않았는지 확인해 주세요.</span><b>저장 전 자동 정리됩니다.</b></div>
      <div className="admin-editor-actions"><button type="reset" disabled={editorBusy} onClick={() => setBody("")}>초기화</button><button type="submit" disabled={submitting || editorBusy}>{editorBusy ? "첨부 중…" : submitting ? "게시 중…" : mode === "events" ? "이벤트 게시" : "공지 게시"}</button></div>
    </div>
  </form>;
}

function AdminPostList({ title, description, posts, onRefresh }: { title: string; description: string; posts: Post[]; onRefresh: () => void }) {
  const categoryLabels: Record<string, string> = { notices: "공지사항", events: "이벤트", reviews: "후기", gifs: "커뮤니티", community: "커뮤니티" };
  return <section className="admin-panel"><div className="panel-title"><div><h2>{title}</h2><p>{description}</p></div><button onClick={onRefresh}>새로고침</button></div><div className="event-list">{posts.length ? posts.map((post) => <article key={post.id}><div><b>{post.isNotice && <em className="admin-notice-badge">공지</em>}{post.title}</b><span>{categoryLabels[post.category] ?? post.category} · {formatDate(post.createdAt)} · {post.author}</span></div><em>{post.status === "published" ? "공개" : "숨김"}</em></article>) : <p className="admin-empty">아직 등록된 게시글이 없습니다.</p>}</div></section>;
}
