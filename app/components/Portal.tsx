"use client";

import { FormEvent, ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import AttendanceModal from "./AttendanceModal";
import { FeaturedVendorDetail, FeaturedVendorGrid, type FeaturedVendorPost } from "./FeaturedVendors";
import LevelProgressModal from "./LevelProgressModal";
import RichTitleInput from "./RichTitleInput";
import RichTextEditor from "./RichTextEditor";
import ShopPage from "./ShopPage";
import SupportReplyComposer from "./SupportReplyComposer";
import { visiblePageNumbers } from "../lib/board-pagination";
import { getSampleBoardPosts } from "../lib/board-sample-posts";
import { comparePopularPosts, isInPopularWindow, postCreatedTime } from "../lib/popular-posts";
import { renderRichBody, renderRichTitle, stripRichTitle } from "../lib/rich-text";
import { horizontalScrollAvailability, horizontalScrollTarget } from "../lib/horizontal-scroll";
import { vendorCategories, vendorRegionGroups as regionGroups, writableVendorCategories } from "../lib/vendor-regions";
import { COMMUNITY_TAGS, isCommunityBoardCategory, type CommunityTag } from "../lib/community-tags";
import { TITLE_COLOR_OPTIONS, type TitleColor } from "../lib/title-colors";
import { attendancePointsForLevel } from "../lib/member-level";

type View = "home" | "notices" | "vendors" | "community" | "reviews" | "events" | "partner" | "support" | "mypage" | "shop";
type BoardKind = "notices" | "reviews" | "events" | "gifs" | "community";
type InquiryKind = "support" | "partner";
type Modal = "login" | "signup" | "attendance" | null;
type Viewer = { nickname: string; points: number; level: number; attended: boolean };
type LivePost = {
  id: number;
  category: BoardKind;
  title: string;
  titleColor: TitleColor;
  body: string;
  author: string;
  authorLevel: number;
  views: number;
  likes: number;
  dislikes: number;
  reportCount: number;
  isNotice: boolean;
  isPinned: boolean;
  commentCount: number;
  isOwn?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canPin?: boolean;
  communityTags: CommunityTag[];
  createdAt: string;
};
type BoardDisplayPost = {
  id: string | number;
  title: string;
  titleColor: TitleColor;
  body: string;
  author: string;
  authorLevel: number;
  time: string;
  views: number;
  likes: number;
  dislikes: number;
  reportCount: number;
  isNotice: boolean;
  isPinned: boolean;
  commentCount: number;
  createdAt?: string;
  isOwn?: boolean;
  canEdit?: boolean;
  canDelete?: boolean;
  canPin?: boolean;
  communityTags: CommunityTag[];
  live: boolean;
};
type PostComment = { id: number; body: string; author: string; authorLevel: number; createdAt: string };
type PostPoll = {
  id: number;
  question: string;
  totalVotes: number;
  selectedOptionId: number | null;
  options: Array<{ id: number; label: string; votes: number; percentage: number }>;
};
type MyPagePost = LivePost;
type PointHistory = { id: number; amount: number; type: string; status: string; reference: string | null; createdAt: string };
type MyPageData = {
  user: { username: string; nickname: string; points: number; level: number };
  posts: MyPagePost[];
  pointHistory: PointHistory[];
};
type SupportInquiry = {
  id: number;
  title: string;
  body: string;
  status: "open" | "answered" | "closed";
  memberUnread: number;
  author: string;
  replyCount: number;
  createdAt: string;
  updatedAt: string;
};
type SupportReply = { id: number; senderType: "member" | "staff"; body: string; createdAt: string };
type EventPeriod = "weekly" | "monthly";
type EventRankRow = { rank: number; userId: number; nickname: string; level: number; count: number; rewardPoints: number; paid: boolean };
type EventLeaderboardData = {
  period: { type: EventPeriod; startAt: string; endAt: string; startDate: string; endDate: string };
  posts: EventRankRow[];
  comments: EventRankRow[];
};
type VendorAssignment = { region: string; district: string; used: number | boolean };
type VendorJumpSummary = { remaining: number; used: number; limit: number; resetText: string };
type VendorTextPost = {
  id: number;
  industry: string;
  region: string;
  district: string;
  title: string;
  titleColor: TitleColor;
  body: string;
  author: string;
  authorLevel: number;
  isOwn: boolean;
  canEdit: boolean;
  canDelete: boolean;
  createdAt: string;
  updatedAt: string;
};
const boardPosts = (kind: BoardKind): BoardDisplayPost[] => getSampleBoardPosts(kind === "gifs" ? "community" : kind).map((post) => ({
  ...post,
  time: formatPostTime(post.createdAt),
  live: false,
}));

const navItems: { key: View; label: string }[] = [
  { key: "home", label: "홈" },
  { key: "notices", label: "공지사항" },
  { key: "vendors", label: "업체정보" },
  { key: "community", label: "커뮤니티" },
  { key: "reviews", label: "후기" },
  { key: "events", label: "이벤트" },
  { key: "partner", label: "제휴문의" },
  { key: "support", label: "고객센터" },
];

export default function Portal() {
  const [view, setView] = useState<View>("home");
  const [vendorCategory, setVendorCategory] = useState("전체");
  const [region, setRegion] = useState("전체");
  const [district, setDistrict] = useState("전체");
  const [query, setQuery] = useState("");
  const [vendorSearch, setVendorSearch] = useState("");
  const [vendorSearchRevision, setVendorSearchRevision] = useState(0);
  const [featuredVendors, setFeaturedVendors] = useState<FeaturedVendorPost[]>([]);
  const [featuredLoading, setFeaturedLoading] = useState(true);
  const [selectedFeaturedVendor, setSelectedFeaturedVendor] = useState<FeaturedVendorPost | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toast, setToast] = useState("");
  const [points, setPoints] = useState(0);
  const [attended, setAttended] = useState(false);
  const [viewer, setViewer] = useState<Viewer | null>(null);
  const [levelProgressOpen, setLevelProgressOpen] = useState(false);
  const [accountSubmitting, setAccountSubmitting] = useState(false);
  const [livePosts, setLivePosts] = useState<Partial<Record<BoardKind, LivePost[]>>>({});
  const [writeKind, setWriteKind] = useState<BoardKind | null>(null);
  const [selectedPost, setSelectedPost] = useState<BoardDisplayPost | null>(null);
  const [postSubmitting, setPostSubmitting] = useState(false);
  const [myPage, setMyPage] = useState<MyPageData | null>(null);
  const [myPageLoading, setMyPageLoading] = useState(false);
  const [supportInquiries, setSupportInquiries] = useState<SupportInquiry[]>([]);
  const [selectedInquiry, setSelectedInquiry] = useState<SupportInquiry | null>(null);
  const [supportReplies, setSupportReplies] = useState<SupportReply[]>([]);
  const [supportWriting, setSupportWriting] = useState(false);
  const [supportLoading, setSupportLoading] = useState(false);
  const [supportSubmitting, setSupportSubmitting] = useState(false);
  const featuredRequestRef = useRef(0);
  const viewerNickname = viewer?.nickname;
  const activeInquiryKind: InquiryKind = view === "partner" ? "partner" : "support";

  useEffect(() => {
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
    fetch(`/api/attendance?month=${month}`, { cache: "no-store" })
      .then((response) => response.json())
      .then((result: { user?: Viewer | null }) => {
        setPoints(result.user?.points ?? 0);
        setAttended(result.user?.attended ?? false);
        setViewer(result.user ?? null);
        window.dispatchEvent(new CustomEvent("cn:member-session", { detail: { authenticated: Boolean(result.user) } }));
      })
      .catch(() => { setPoints(0); setAttended(false); setViewer(null); });
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const board = params.get("board");
    const postId = Number(params.get("post"));
    if (!(board === "notices" || board === "reviews" || board === "events" || board === "gifs" || board === "community")) return;
    const viewBoard = board === "gifs" ? "community" : board;
    const timer = window.setTimeout(() => {
      setView(viewBoard);
      if (!Number.isInteger(postId) || postId < 1) return;
      fetch(`/api/posts?category=${viewBoard}`, { cache: "no-store" }).then(async (response) => {
        const result = await response.json() as { posts?: LivePost[]; error?: string };
        const sharedPost = result.posts?.find((item) => item.id === postId);
        if (!response.ok || !sharedPost) throw new Error(result.error ?? "게시글을 불러오지 못했습니다.");
        setSelectedPost({
          id: sharedPost.id, title: sharedPost.title, titleColor: sharedPost.titleColor || "", body: sharedPost.body, communityTags: sharedPost.communityTags, author: sharedPost.author,
          authorLevel: sharedPost.authorLevel, time: formatPostTime(sharedPost.createdAt), views: sharedPost.views,
          likes: sharedPost.likes, dislikes: sharedPost.dislikes ?? 0, reportCount: sharedPost.reportCount ?? 0, isNotice: Boolean(sharedPost.isNotice), isPinned: Boolean(sharedPost.isPinned),
          commentCount: sharedPost.commentCount, isOwn: sharedPost.isOwn, canEdit: sharedPost.canEdit, canDelete: sharedPost.canDelete, createdAt: sharedPost.createdAt, live: true,
        });
      }).catch(() => { window.history.replaceState(null, "", window.location.pathname); });
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.setTimeout(() => setToast(""), 2600);
  }, []);

  const handleLevelChange = useCallback((nextLevel: number) => {
    setViewer((current) => current ? { ...current, level: nextLevel } : current);
    setMyPage((current) => current ? { ...current, user: { ...current.user, level: nextLevel } } : current);
  }, []);

  const handleLevelSessionExpired = useCallback(() => {
    setLevelProgressOpen(false);
    setViewer(null);
    setPoints(0);
    setAttended(false);
    setMyPage(null);
    setModal("login");
    showToast("로그인이 만료되었습니다. 다시 로그인해 주세요.");
  }, [showToast]);

  const loadFeaturedVendors = useCallback(async () => {
    const requestId = ++featuredRequestRef.current;
    setFeaturedLoading(true);
    try {
      const response = await fetch("/api/featured-vendors", { cache: "no-store" });
      const result = await response.json() as { posts?: FeaturedVendorPost[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "추천 업체를 불러오지 못했습니다.");
      if (featuredRequestRef.current !== requestId) return;
      const posts = [...(result.posts ?? [])].sort((left, right) => left.slot - right.slot).slice(0, 4);
      setFeaturedVendors(posts);
      setSelectedFeaturedVendor((current) => current ? posts.find((post) => post.slot === current.slot) ?? null : null);
    } catch (error) {
      if (featuredRequestRef.current === requestId) showToast(error instanceof Error ? error.message : "추천 업체를 불러오지 못했습니다.");
    } finally {
      if (featuredRequestRef.current === requestId) setFeaturedLoading(false);
    }
  }, [showToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadFeaturedVendors(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFeaturedVendors, viewerNickname]);

  useEffect(() => {
    if (!featuredVendors.length) return;
    const slot = Number(new URLSearchParams(window.location.search).get("featured"));
    const featured = Number.isInteger(slot) ? featuredVendors.find((post) => post.slot === slot) : null;
    if (!featured) return;
    const timer = window.setTimeout(() => { setView("vendors"); setSelectedFeaturedVendor(featured); }, 0);
    return () => window.clearTimeout(timer);
  }, [featuredVendors]);

  const loadPosts = useCallback(async (kind: BoardKind) => {
    try {
      const response = await fetch(`/api/posts?category=${kind}`, { cache: "no-store" });
      const result = await response.json() as { posts?: LivePost[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "게시글을 불러오지 못했습니다.");
      setLivePosts((current) => ({ ...current, [kind]: result.posts ?? [] }));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "게시글을 불러오지 못했습니다.");
    }
  }, [showToast]);

  useEffect(() => {
    if (!(["notices", "reviews", "events", "community"] as View[]).includes(view)) return;
    const kind = view as BoardKind;
    const timer = window.setTimeout(() => void loadPosts(kind), 0);
    return () => window.clearTimeout(timer);
  }, [loadPosts, view]);

  useEffect(() => {
    if (view !== "mypage") return;
    if (!viewerNickname) return;
    let active = true;
    fetch("/api/mypage", { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as MyPageData & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "마이페이지 정보를 불러오지 못했습니다.");
      if (!active) return;
      setMyPage(result);
      setPoints(result.user.points);
      setViewer((current) => current ? { ...current, points: result.user.points, level: result.user.level, nickname: result.user.nickname } : current);
    }).catch((error) => {
      if (active) showToast(error instanceof Error ? error.message : "마이페이지 정보를 불러오지 못했습니다.");
    }).finally(() => {
      if (active) setMyPageLoading(false);
    });
    return () => { active = false; };
  }, [showToast, view, viewerNickname]);

  const loadSupport = useCallback(async () => {
    if (!viewer) return;
    setSupportLoading(true);
    try {
      const response = await fetch(`/api/support?kind=${activeInquiryKind}`, { cache: "no-store" });
      const result = await response.json() as { inquiries?: SupportInquiry[]; error?: string };
      if (!response.ok) throw new Error(result.error ?? "문의 목록을 불러오지 못했습니다.");
      setSupportInquiries(result.inquiries ?? []);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "문의 목록을 불러오지 못했습니다.");
    } finally {
      setSupportLoading(false);
    }
  }, [activeInquiryKind, showToast, viewer]);

  useEffect(() => {
    if (view !== "support" && view !== "partner") return;
    if (!viewer) return;
    const timer = window.setTimeout(() => void loadSupport(), 0);
    return () => window.clearTimeout(timer);
  }, [loadSupport, view, viewer]);

  const selectRegion = (nextRegion: string, nextDistrict = "전체") => {
    setRegion(nextRegion);
    setDistrict(nextDistrict);
  };

  const go = (next: View) => {
    if (next === "vendors") {
      setQuery("");
      setVendorSearch("");
      setVendorSearchRevision((current) => current + 1);
    }
    setView(next);
    setWriteKind(null);
    setSelectedPost(null);
    setSelectedFeaturedVendor(null);
    setSupportWriting(false);
    setSelectedInquiry(null);
    setSupportReplies([]);
    if (next === "support" || next === "partner") setSupportInquiries([]);
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "auto" });
  };

  const openFeaturedVendor = (post: FeaturedVendorPost) => {
    go("vendors");
    setSelectedFeaturedVendor(post);
    window.history.replaceState(null, "", `${window.location.pathname}?featured=${post.slot}`);
  };

  const closeFeaturedVendor = () => {
    setSelectedFeaturedVendor(null);
    window.history.replaceState(null, "", window.location.pathname);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const saveFeaturedVendor = (post: FeaturedVendorPost) => {
    setFeaturedVendors((current) => current.map((item) => item.slot === post.slot ? post : item));
    setSelectedFeaturedVendor(post);
  };

  const openMyPage = () => {
    if (!viewer) {
      setModal("login");
      showToast("로그인 후 마이페이지를 확인할 수 있습니다.");
      return;
    }
    setMyPageLoading(true);
    go("mypage");
  };

  const openShop = () => {
    if (!viewer) {
      setModal("login");
      showToast("로그인 후 포인트 상점을 이용할 수 있습니다.");
      return;
    }
    go("shop");
  };

  const openMyPost = (post: MyPagePost) => {
    const board = post.category === "gifs" ? "community" : post.category;
    setView(board);
    setWriteKind(null);
    setSelectedPost({
      id: post.id, title: post.title, titleColor: post.titleColor || "", body: post.body, communityTags: post.communityTags, author: post.author, authorLevel: post.authorLevel,
      time: formatPostTime(post.createdAt), views: post.views, likes: post.likes, dislikes: post.dislikes ?? 0,
      reportCount: post.reportCount ?? 0, isNotice: Boolean(post.isNotice), isPinned: Boolean(post.isPinned), commentCount: post.commentCount ?? 0,
      isOwn: true, canEdit: true, canDelete: true, createdAt: post.createdAt, live: true,
    });
    window.history.replaceState(null, "", `${window.location.pathname}?board=${board}&post=${post.id}`);
    window.scrollTo({ top: 70, behavior: "smooth" });
  };

  const submitAccount = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (accountSubmitting) return;
    const form = new FormData(event.currentTarget);
    if (modal === "signup" && form.get("password") !== form.get("passwordConfirm")) {
      return showToast("비밀번호와 비밀번호 확인이 일치하지 않습니다.");
    }
    setAccountSubmitting(true);
    try {
      const endpoint = modal === "signup" ? "/api/auth/register" : "/api/auth/login";
      const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(Object.fromEntries(form)) });
      const result = await response.json() as { error?: string; user?: Viewer };
      if (!response.ok) throw new Error(result.error ?? "처리 중 오류가 발생했어요.");
      if (modal === "signup") {
        showToast("가입 완료! 이제 로그인해 주세요.");
        setModal("login");
      } else {
        const nextViewer = result.user ?? { nickname: "회원", points: 0, level: 1, attended: false };
        setViewer(nextViewer);
        window.dispatchEvent(new CustomEvent("cn:member-session", { detail: { authenticated: true } }));
        setPoints(nextViewer.points);
        setAttended(nextViewer.attended);
        showToast(`${nextViewer.nickname}님, 반가워요!`);
        setModal(null);
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "처리 중 오류가 발생했어요.");
    } finally {
      setAccountSubmitting(false);
    }
  };

  const logout = async () => {
    try { await fetch("/api/auth/logout", { method: "POST" }); } finally {
      setLevelProgressOpen(false);
      setViewer(null);
      window.dispatchEvent(new CustomEvent("cn:member-session", { detail: { authenticated: false } }));
      setPoints(0);
      setAttended(false);
      setMyPage(null);
      showToast("로그아웃했습니다.");
    }
  };

  const openWrite = (kind: BoardKind) => {
    if (!viewer) {
      setModal("login");
      showToast("로그인 후 글을 작성할 수 있어요.");
      return;
    }
    setSelectedPost(null);
    setWriteKind(kind);
  };

  const submitPost = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!writeKind || postSubmitting) return;
    const form = new FormData(event.currentTarget);
    const communityTags = form.getAll("communityTags").filter((value): value is string => typeof value === "string");
    if (isCommunityBoardCategory(writeKind) && communityTags.length === 0) {
      showToast("머릿글을 하나 이상 선택해 주세요.");
      return;
    }
    setPostSubmitting(true);
    try {
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ category: writeKind, title: form.get("title"), titleColor: form.get("titleColor"), body: form.get("body"), isPinned: form.get("isPinned") === "on", ...(isCommunityBoardCategory(writeKind) ? { communityTags } : {}) }),
      });
      const result = await response.json() as { post?: LivePost; earnedPoints?: number; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "게시글을 저장하지 못했습니다.");
      const createdPost = result.post;
      setLivePosts((current) => ({
        ...current,
        [writeKind]: [createdPost, ...(current[writeKind] ?? [])].sort((left, right) => Number(Boolean(right.isPinned)) - Number(Boolean(left.isPinned)) || right.id - left.id),
      }));
      setWriteKind(null);
      setSelectedPost({
        id: createdPost.id, title: createdPost.title, titleColor: createdPost.titleColor || "", body: createdPost.body, communityTags: createdPost.communityTags, author: createdPost.author,
        authorLevel: createdPost.authorLevel, time: formatPostTime(createdPost.createdAt), views: createdPost.views,
        likes: createdPost.likes, dislikes: createdPost.dislikes, reportCount: createdPost.reportCount, isNotice: Boolean(createdPost.isNotice), isPinned: Boolean(createdPost.isPinned),
        commentCount: createdPost.commentCount, isOwn: true, canEdit: true, canDelete: true, createdAt: createdPost.createdAt, live: true,
      });
      window.history.replaceState(null, "", `${window.location.pathname}?board=${writeKind}&post=${createdPost.id}`);
      if ((result.earnedPoints ?? 0) > 0) {
        const earnedPoints = result.earnedPoints ?? 0;
        setPoints((current) => current + earnedPoints);
        setViewer((current) => current ? { ...current, points: current.points + earnedPoints } : current);
        setMyPage(null);
        showToast(`게시글이 등록되었습니다. +${earnedPoints.toLocaleString()}P`);
      } else {
        showToast("게시글이 등록되었습니다.");
      }
    } catch (error) {
      showToast(error instanceof Error ? error.message : "게시글을 저장하지 못했습니다.");
    } finally {
      setPostSubmitting(false);
    }
  };

  const openSupportWrite = () => {
    if (!viewer) {
      setModal("login");
      showToast("로그인 후 1:1문의를 작성할 수 있습니다.");
      return;
    }
    setSelectedInquiry(null);
    setSupportWriting(true);
  };

  const submitSupport = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (supportSubmitting) return;
    const form = new FormData(event.currentTarget);
    setSupportSubmitting(true);
    try {
      const response = await fetch(`/api/support?kind=${activeInquiryKind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: form.get("title"), body: form.get("body") }),
      });
      const result = await response.json() as { inquiry?: SupportInquiry; error?: string };
      if (!response.ok || !result.inquiry) throw new Error(result.error ?? "문의글을 저장하지 못했습니다.");
      setSupportInquiries((current) => [result.inquiry!, ...current]);
      setSelectedInquiry(result.inquiry);
      setSupportReplies([]);
      setSupportWriting(false);
      showToast("1:1문의가 접수되었습니다.");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "문의글을 저장하지 못했습니다.");
    } finally {
      setSupportSubmitting(false);
    }
  };

  const openInquiry = async (inquiry: SupportInquiry) => {
    if (!viewer || supportLoading) return;
    setSupportWriting(false);
    setSelectedInquiry(inquiry);
    setSupportLoading(true);
    try {
      const response = await fetch(`/api/support/${inquiry.id}?kind=${activeInquiryKind}`, { cache: "no-store" });
      const result = await response.json() as { inquiry?: SupportInquiry; replies?: SupportReply[]; error?: string };
      if (!response.ok || !result.inquiry) throw new Error(result.error ?? "문의글을 불러오지 못했습니다.");
      setSelectedInquiry(result.inquiry);
      setSupportReplies(result.replies ?? []);
      setSupportInquiries((current) => current.map((item) => item.id === inquiry.id ? { ...item, memberUnread: 0, status: result.inquiry!.status, replyCount: result.replies?.length ?? item.replyCount } : item));
    } catch (error) {
      showToast(error instanceof Error ? error.message : "문의글을 불러오지 못했습니다.");
    } finally {
      setSupportLoading(false);
    }
  };

  const submitSupportReply = async (body: string): Promise<boolean> => {
    if (!selectedInquiry || supportSubmitting) return false;
    setSupportSubmitting(true);
    try {
      const response = await fetch(`/api/support/${selectedInquiry.id}?kind=${activeInquiryKind}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
      const result = await response.json() as SupportReply & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "댓글을 저장하지 못했습니다.");
      setSupportReplies((current) => [...current, result]);
      setSupportInquiries((current) => current.map((item) => item.id === selectedInquiry.id ? { ...item, status: "open", replyCount: item.replyCount + 1, updatedAt: result.createdAt } : item));
      showToast("댓글이 등록되었습니다.");
      return true;
    } catch (error) {
      showToast(error instanceof Error ? error.message : "댓글을 저장하지 못했습니다.");
      return false;
    } finally {
      setSupportSubmitting(false);
    }
  };

  const search = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const keyword = query.trim();
    go("vendors");
    setVendorCategory("전체");
    setRegion("전체");
    setDistrict("전체");
    setQuery(keyword);
    setVendorSearch(keyword);
  };

  return (
    <div className="site-shell">
      <header className="site-header">
        <div className="header-top page-width">
          <button className="logo-button" onClick={() => go("home")} aria-label="출장나라 홈">
            <img src="/logo.png" alt="출장나라" />
          </button>
          <form className="search" onSubmit={search}>
            <input value={query} onChange={(e) => setQuery(e.target.value)} maxLength={80} placeholder="지역·업종·업체명 검색" aria-label="업체정보 검색" />
            <button type="submit" aria-label="검색">⌕</button>
          </form>
          <div className="member-actions">
            {viewer ? <><button type="button" className="member-level" onClick={() => setLevelProgressOpen(true)} aria-haspopup="dialog" aria-expanded={levelProgressOpen} aria-label={`Lv.${viewer.level} 레벨업 안내 열기`}>Lv.{viewer.level}</button><span className="member-name" title={viewer.nickname}>{viewer.nickname}님</span><button className="mypage-button" onClick={openMyPage}>마이페이지</button>{viewer.level === 10 && <a className="admin-link" href="/admin">관리자</a>}<button className="logout-button" onClick={logout}>로그아웃</button></> : <><button className="text-button" onClick={() => setModal("login")}>로그인</button><button className="primary-button" onClick={() => setModal("signup")}>회원가입</button></>}
          </div>
        </div>
        <nav className="main-nav page-width" aria-label="주요 메뉴">
          {navItems.map((item) => <button key={item.key} className={view === item.key ? "active" : ""} onClick={() => go(item.key)}>{item.label}</button>)}
        </nav>
      </header>

      <main>
        {view === "home" ? (
          <>
            <section className="home-overview page-width" aria-label="업체 검색과 회원 이용 현황">
              <div className="hero-search-panel">
                <p>VENDOR SEARCH</p>
                <h1>원하는 지역과 업체를<br />빠르게 찾아보세요.</h1>
                <form className="hero-vendor-search" onSubmit={search}>
                  <label htmlFor="hero-vendor-search">업체정보 검색</label>
                  <div>
                    <input id="hero-vendor-search" value={query} onChange={(event) => setQuery(event.target.value)} maxLength={80} placeholder="지역·업종·업체명 검색" />
                    <button type="submit">검색</button>
                  </div>
                </form>
                <small>지역·상세지역·업종·제목·본문 내용으로 검색됩니다.</small>
              </div>
              <aside className="quick-strip" aria-label="회원 이용 현황">
                <div className="quick-trust"><span className="status-dot" /> <p><b>실시간 검증 운영</b><small>업체 정보와 신고 내역을 상시 확인합니다.</small></p></div>
                <div className="quick-account">
                  <div className="point-summary"><span className="quick-label">나의 포인트</span><button type="button" className="point-shop-link" onClick={openShop} aria-label={`보유 포인트 ${points.toLocaleString()}P로 상점 열기`}><strong>{points.toLocaleString()}P</strong><small>상점 ›</small></button></div>
                  <div className="attendance-summary"><span className="quick-label">오늘의 출석</span><strong className={attended ? "attendance-status complete" : "attendance-status"}>{attended ? "출석완료" : "출석 전"}</strong><button className={attended ? "done" : ""} onClick={() => setModal("attendance")}>{attended ? "출석 내역" : "출석 체크"}</button></div>
                </div>
              </aside>
            </section>

            <section className="content-section page-width">
              <div className="section-heading compact"><h2>인기 지역</h2><button onClick={() => go("vendors")}>전체 지역 보기 <span>›</span></button></div>
              <RegionSelector
                compact
                region={region}
                district={district}
                onSelectRegion={selectRegion}
                onSelectDistrict={(nextDistrict) => { setVendorCategory("전체"); setDistrict(nextDistrict); go("vendors"); }}
              />
            </section>

            <VendorSection posts={featuredVendors} loading={featuredLoading} onOpen={openFeaturedVendor} onMore={() => go("vendors")} />

            <section className="board-grid page-width">
              <BoardPreview kind="reviews" title="실시간 후기" posts={boardPosts("reviews").slice(0, 5)} onMore={() => go("reviews")} />
              <BoardPreview kind="community" title="커뮤니티" posts={boardPosts("community").slice(0, 5)} onMore={() => go("community")} />
            </section>

            <section className="editorial page-width">
              <div><span>WELCOME BENEFIT</span><h2>오늘 출석하면<br />{attendancePointsForLevel(viewer?.level ?? 1)}P 적립</h2><p>레벨이 오를수록 출석 포인트도 함께 올라갑니다.</p><button onClick={() => setModal(viewer ? "attendance" : "signup")}>{viewer ? "오늘 출석하기" : "3초 회원가입"}</button></div>
              <img src="/images/vendor-04.jpg" alt="편안한 웰니스 공간" />
            </section>
          </>
        ) : view === "vendors" ? (
          <section className="listing-page vendor-listing page-width">
            {selectedFeaturedVendor ? <FeaturedVendorDetail post={selectedFeaturedVendor} onClose={closeFeaturedVendor} onSaved={saveFeaturedVendor} showToast={showToast} /> : <>
              <div className="filter-bar">
                <VendorCategorySelector category={vendorCategory} onSelect={setVendorCategory} />
                <RegionSelector
                  region={region}
                  district={district}
                  onSelectRegion={selectRegion}
                  onSelectDistrict={setDistrict}
                />
              </div>
              <FeaturedVendorGrid posts={featuredVendors} loading={featuredLoading} onOpen={openFeaturedVendor} />
              <VendorTextBoard
                key={`${vendorCategory}|${region}|${district}|${vendorSearch}|${vendorSearchRevision}`}
                industry={vendorCategory}
                region={region}
                district={district}
                search={vendorSearch}
                viewerKey={viewer?.nickname ?? ""}
                onClearSearch={() => { setQuery(""); setVendorSearch(""); setVendorSearchRevision((current) => current + 1); }}
                onLoginRequired={() => setModal("login")}
                showToast={showToast}
              />
            </>}
          </section>
        ) : view === "shop" ? (
          <ShopPage
            viewer={viewer ? { points, level: viewer.level } : null}
            onLoginRequired={() => { setModal("login"); showToast("로그인 후 포인트 상점을 이용할 수 있습니다."); }}
            onSessionExpired={() => { setViewer(null); setPoints(0); setAttended(false); setMyPage(null); setModal("login"); showToast("로그인이 만료되었습니다. 다시 로그인해 주세요."); }}
            onPointsChange={(nextPoints) => { setPoints(nextPoints); setViewer((current) => current ? { ...current, points: nextPoints } : current); setMyPage(null); }}
            showToast={showToast}
          />
        ) : view === "support" || view === "partner" ? (
          <SupportBoard
            kind={activeInquiryKind}
            inquiries={supportInquiries}
            selectedInquiry={selectedInquiry}
            replies={supportReplies}
            writing={supportWriting}
            loading={supportLoading}
            submitting={supportSubmitting}
            loggedIn={Boolean(viewer)}
            onWrite={openSupportWrite}
            onCancelWrite={() => setSupportWriting(false)}
            onSubmit={submitSupport}
            onOpen={(inquiry) => void openInquiry(inquiry)}
            onCloseDetail={() => { setSelectedInquiry(null); setSupportReplies([]); }}
            onLoginRequired={() => setModal("login")}
            onReply={submitSupportReply}
          />
        ) : view === "mypage" ? (
          <MyPage key={viewerNickname || "guest"} data={myPage} loading={myPageLoading} onOpenPost={openMyPost} onOpenShop={openShop} loggedIn={Boolean(viewer)} />
        ) : view === "events" ? (
          <EventPage
            kind="events"
            livePosts={livePosts.events ?? []}
            viewer={viewer}
            writing={writeKind === "events"}
            selectedPost={selectedPost}
            submitting={postSubmitting}
            onWrite={() => openWrite("events")}
            onCancelWrite={() => setWriteKind(null)}
            onSubmit={submitPost}
            onOpen={(post) => {
              setWriteKind(null); setSelectedPost(post);
              if (post.live) window.history.replaceState(null, "", `${window.location.pathname}?board=events&post=${post.id}`);
              window.scrollTo({ top: 70, behavior: "smooth" });
            }}
            onLoginRequired={() => setModal("login")}
            onPostChange={(post) => {
              setSelectedPost(post);
              if (typeof post.id === "number") setLivePosts((current) => ({
                ...current,
                events: (current.events ?? []).map((item) => item.id === post.id ? { ...item, title: post.title, titleColor: post.titleColor, body: post.body, communityTags: post.communityTags, views: post.views, likes: post.likes, dislikes: post.dislikes, reportCount: post.reportCount, isNotice: post.isNotice, isPinned: post.isPinned, commentCount: post.commentCount, isOwn: post.isOwn, canEdit: post.canEdit, canDelete: post.canDelete } : item),
              }));
            }}
            onPostRemoved={(postId) => {
              setSelectedPost(null);
              setLivePosts((current) => ({ ...current, events: (current.events ?? []).filter((item) => item.id !== postId) }));
              window.history.replaceState(null, "", `${window.location.pathname}?board=events`);
            }}
            onPointReward={(earnedPoints) => {
              setPoints((current) => current + earnedPoints);
              setViewer((current) => current ? { ...current, points: current.points + earnedPoints } : current);
              setMyPage(null);
            }}
            showToast={showToast}
          />
        ) : (
          <BoardPage
            key={view}
            kind={view as BoardKind}
            livePosts={livePosts[view as BoardKind] ?? []}
            viewer={viewer}
            writing={writeKind === view}
            selectedPost={selectedPost}
            submitting={postSubmitting}
            onWrite={() => openWrite(view as BoardKind)}
            onCancelWrite={() => setWriteKind(null)}
            onSubmit={submitPost}
            onOpen={(post) => {
              setWriteKind(null); setSelectedPost(post);
              if (post.live) window.history.replaceState(null, "", `${window.location.pathname}?board=${view}&post=${post.id}`);
              window.scrollTo({ top: 70, behavior: "smooth" });
            }}
            onLoginRequired={() => setModal("login")}
            onPostChange={(post) => {
              setSelectedPost(post);
              if (typeof post.id === "number") setLivePosts((current) => ({
                ...current,
                [view as BoardKind]: (current[view as BoardKind] ?? []).map((item) => item.id === post.id ? { ...item, title: post.title, titleColor: post.titleColor, body: post.body, communityTags: post.communityTags, views: post.views, likes: post.likes, dislikes: post.dislikes, reportCount: post.reportCount, isNotice: post.isNotice, isPinned: post.isPinned, commentCount: post.commentCount, isOwn: post.isOwn, canEdit: post.canEdit, canDelete: post.canDelete } : item),
              }));
            }}
            onPostRemoved={(postId) => {
              setSelectedPost(null);
              setLivePosts((current) => ({ ...current, [view as BoardKind]: (current[view as BoardKind] ?? []).filter((item) => item.id !== postId) }));
              window.history.replaceState(null, "", `${window.location.pathname}?board=${view}`);
            }}
            onPointReward={(earnedPoints) => {
              setPoints((current) => current + earnedPoints);
              setViewer((current) => current ? { ...current, points: current.points + earnedPoints } : current);
              setMyPage(null);
            }}
            showToast={showToast}
          />
        )}
      </main>

      <footer className="site-footer">
        <div className="page-width footer-inner">
          <div><img src="/logo.png" alt="출장나라" /><p>검증된 정보와 건강한 이용 문화를 만듭니다.</p></div>
          <p className="copyright">© 2026 출장나라. All rights reserved.</p>
          <div className="socials" aria-label="소셜 미디어">
            <a className="social-instagram" href="https://www.instagram.com/care_nara_/" target="_blank" rel="noreferrer" aria-label="인스타그램 새 창으로 열기" />
            <button className="social-telegram" type="button" aria-label="텔레그램 링크 준비 중" />
            <a className="social-x" href="https://x.com/care_nara_" target="_blank" rel="noreferrer" aria-label="트위터 X 새 창으로 열기" />
          </div>
        </div>
      </footer>

      {modal === "attendance" ? <AttendanceModal onClose={() => setModal(null)} onLoginRequired={() => setModal("login")} onAttendance={(nextPoints, nextLevel) => { setPoints(nextPoints); setAttended(true); setViewer((current) => current ? { ...current, points: nextPoints, level: nextLevel ?? current.level, attended: true } : current); }} showToast={showToast} /> : modal && <Modal type={modal} onClose={() => setModal(null)} onSubmit={submitAccount} onSwitch={setModal} submitting={accountSubmitting} />}
      {levelProgressOpen && viewer && <LevelProgressModal onClose={() => setLevelProgressOpen(false)} onLevelChange={handleLevelChange} onSessionExpired={handleLevelSessionExpired} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function MyPage({ data, loading, loggedIn, onOpenPost, onOpenShop }: {
  data: MyPageData | null;
  loading: boolean;
  loggedIn: boolean;
  onOpenPost: (post: MyPagePost) => void;
  onOpenShop: () => void;
}) {
  const [visiblePostCount, setVisiblePostCount] = useState(5);
  const [visiblePointCount, setVisiblePointCount] = useState(5);
  const posts = data?.posts ?? [];
  const pointHistory = data?.pointHistory ?? [];
  const visiblePosts = posts.slice(0, visiblePostCount);
  const visiblePoints = pointHistory.slice(0, visiblePointCount);
  const remainingPosts = Math.max(0, posts.length - visiblePostCount);
  const remainingPoints = Math.max(0, pointHistory.length - visiblePointCount);

  return <section className="mypage page-width">
    <div className="page-intro mypage-intro">
      <p className="eyebrow">MY PAGE</p>
      <h1>마이페이지</h1>
      <p>내가 작성한 글과 포인트 적립 내역을 한곳에서 확인하세요.</p>
    </div>

    {!loggedIn ? <div className="mypage-empty"><b>로그인이 필요합니다.</b><p>로그인 후 마이페이지를 확인할 수 있습니다.</p></div> : <>
      <div className="mypage-summary">
        <article><span>닉네임</span><strong>{data?.user.nickname ?? "불러오는 중"}</strong></article>
        <article><span>회원등급</span><strong>Lv.{data?.user.level ?? 1}</strong></article>
        <article><span>보유 포인트</span><strong>{(data?.user.points ?? 0).toLocaleString()}P</strong></article>
      </div>

      <div className="mypage-grid">
        <section className="mypage-panel">
          <div className="mypage-panel-title"><div><p>POSTS</p><h2>작성글 목록</h2></div><span>{posts.length}개</span></div>
          <div className="mypage-post-list">
            {loading ? <p className="mypage-empty-line">작성글을 불러오는 중입니다.</p> : posts.length ? visiblePosts.map((post) => (
              <button type="button" key={post.id} onClick={() => onOpenPost(post)}>
                <span>{boardLabels[post.category]}</span>
                <b><CommunityPostTitle category={post.category} title={post.title} titleColor={post.titleColor} tags={post.communityTags} />{post.commentCount > 0 && <em>[{post.commentCount}]</em>}</b>
                <small>추천 {post.likes.toLocaleString()} · 댓글 {post.commentCount.toLocaleString()} · 조회 {post.views.toLocaleString()} · {formatPostTime(post.createdAt)}</small>
              </button>
            )) : <p className="mypage-empty-line">아직 작성한 글이 없습니다.</p>}
          </div>
          {!loading && remainingPosts > 0 && <button className="mypage-more" type="button" aria-label={`작성글 ${Math.min(10, remainingPosts)}개 더 보기`} onClick={() => setVisiblePostCount((count) => count + 10)}>더보기 <span>+{Math.min(10, remainingPosts)}</span></button>}
        </section>

        <section className="mypage-panel points-panel">
          <div className="mypage-panel-title"><div><p>POINTS</p><h2>포인트내역</h2></div><div className="mypage-point-actions"><strong>{(data?.user.points ?? 0).toLocaleString()}P</strong><button type="button" onClick={onOpenShop}>상점</button></div></div>
          <div className="point-history-list">
            {loading ? <p className="mypage-empty-line">포인트 내역을 불러오는 중입니다.</p> : pointHistory.length ? visiblePoints.map((item) => (
              <div key={item.id}>
                <span><b>{pointTypeLabel(item.type)}</b><small>{item.reference || "포인트 적립"}</small></span>
                <strong className={item.amount >= 0 ? "plus" : "minus"}>{item.amount >= 0 ? "+" : ""}{item.amount.toLocaleString()}P</strong>
                <time>{formatPointDate(item.createdAt)}</time>
              </div>
            )) : <p className="mypage-empty-line">아직 포인트 내역이 없습니다.</p>}
          </div>
          {!loading && remainingPoints > 0 && <button className="mypage-more" type="button" aria-label={`포인트 내역 ${Math.min(10, remainingPoints)}개 더 보기`} onClick={() => setVisiblePointCount((count) => count + 10)}>더보기 <span>+{Math.min(10, remainingPoints)}</span></button>}
        </section>
      </div>
    </>}
  </section>;
}

function SupportBoard({ kind, inquiries, selectedInquiry, replies, writing, loading, submitting, loggedIn, onWrite, onCancelWrite, onSubmit, onOpen, onCloseDetail, onLoginRequired, onReply }: {
  kind: InquiryKind;
  inquiries: SupportInquiry[];
  selectedInquiry: SupportInquiry | null;
  replies: SupportReply[];
  writing: boolean;
  loading: boolean;
  submitting: boolean;
  loggedIn: boolean;
  onWrite: () => void;
  onCancelWrite: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOpen: (inquiry: SupportInquiry) => void;
  onCloseDetail: () => void;
  onLoginRequired: () => void;
  onReply: (body: string) => void;
}) {
  const copy = kind === "partner"
    ? { eyebrow: "PARTNERSHIP", title: "제휴문의", lead: "제휴 문의글은 작성자 본인과 운영자만 확인할 수 있습니다.", notice: "제휴문의 게시판입니다. (작성자 본인과 운영자만 볼 수 있습니다.)" }
    : { eyebrow: "CUSTOMER CENTER", title: "1:1문의하기", lead: "문의글은 작성자 본인과 운영자만 확인할 수 있습니다.", notice: "1:1문의 게시판입니다. (작성자 본인과 운영자만 볼 수 있습니다.)" };
  return <section className="board-page support-page page-width">
    <div className="forum-heading"><p className="eyebrow">{copy.eyebrow}</p><h1>{copy.title}</h1><p>{copy.lead}</p></div>
    {writing ? <SupportWritePage kind={kind} onCancel={onCancelWrite} onSubmit={onSubmit} submitting={submitting} /> : <>
      {selectedInquiry && <SupportDetail inquiry={selectedInquiry} replies={replies} submitting={submitting} onClose={onCloseDetail} onReply={onReply} />}
      <div className="support-board-notice" role="note"><b>알림</b><span>{copy.notice}</span><small>운영자</small></div>
      <div className="forum-table support-table" role="table" aria-label="1:1문의 목록">
        <div className="forum-row forum-head" role="row"><span>번호</span><b>제목</b><span>이름</span><span>답변</span><span>날짜</span></div>
        {!loggedIn ? <div className="forum-empty">로그인 후 1:1문의를 작성하고 확인할 수 있습니다.</div> : loading ? <div className="forum-empty">문의 목록을 불러오는 중입니다.</div> : inquiries.length ? inquiries.map((inquiry) => (
          <button type="button" className="forum-row support-row" key={inquiry.id} onClick={() => onOpen(inquiry)}>
            <span>{inquiry.id}</span><b>{inquiry.memberUnread > 0 && <em>[새답변]</em>}{inquiry.title}{inquiry.replyCount > 0 && <em>[{inquiry.replyCount}]</em>}<small>{inquiry.author} · {formatPostTime(inquiry.createdAt)}</small></b><span>{inquiry.author}</span><span>{supportStatusLabel(inquiry.status)}</span><span>{formatPostTime(inquiry.createdAt)}</span>
          </button>
        )) : <div className="forum-empty">게시물이 없습니다.</div>}
      </div>
      <div className="forum-bottom support-bottom">
        <button type="button" className="forum-search-button">검색</button>
        <div className="forum-pagination"><button type="button" aria-label="이전 페이지">‹</button><button type="button" className="active">1</button><button type="button" aria-label="다음 페이지">›</button></div>
        <button type="button" className="forum-write-button" onClick={loggedIn ? onWrite : onLoginRequired}>글쓰기</button>
      </div>
    </>}
  </section>;
}

function SupportWritePage({ kind, onCancel, onSubmit, submitting }: { kind: InquiryKind; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submitting: boolean }) {
  const [body, setBody] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const title = kind === "partner" ? "제휴문의 글쓰기" : "1:1문의 글쓰기";
  const submitLabel = kind === "partner" ? "제휴문의 등록" : "문의 등록";
  return <form className="forum-write support-write" onSubmit={(event) => { if (editorBusy) { event.preventDefault(); return; } onSubmit(event); }}>
    <div className="forum-write-title"><strong>{title}</strong><span>작성하신 문의는 본인과 운영자만 확인할 수 있습니다.</span></div>
    <input className="forum-title-input" name="title" required minLength={2} maxLength={80} autoFocus placeholder="문의 제목을 입력해 주세요." />
    <RichTextEditor name="body" value={body} onChange={setBody} onBusyChange={setEditorBusy} compact allowPoll={false} placeholder="문의 내용을 입력해 주세요." />
    <div className="forum-write-note"><b>비공개 문의 안내</b><span>문의글과 답변은 작성자 본인과 운영자에게만 표시됩니다.</span></div>
    <div className="forum-write-actions"><button type="button" disabled={editorBusy} onClick={onCancel}>취소</button><button type="submit" disabled={submitting || editorBusy}>{editorBusy ? "첨부 중…" : submitting ? "접수 중…" : submitLabel}</button></div>
  </form>;
}

function SupportDetail({ inquiry, replies, submitting, onClose, onReply }: {
  inquiry: SupportInquiry;
  replies: SupportReply[];
  submitting: boolean;
  onClose: () => void;
  onReply: (body: string) => Promise<boolean>;
}) {
  return <article className="forum-detail support-detail">
    <header><h2>{inquiry.title}</h2><div><span>{inquiry.author}</span><span>{new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(inquiry.createdAt))}</span><span>{supportStatusLabel(inquiry.status)}</span><span>댓글 {replies.length}</span></div></header>
    <div className="forum-detail-body rich-body" dangerouslySetInnerHTML={{ __html: renderRichBody(inquiry.body) }} />
    <section className="forum-comments">
      <div className="comment-heading"><b>문의 댓글 <em>{replies.length}</em>개</b><button type="button" onClick={onClose}>목록</button></div>
      <div className="comment-list">
        {replies.map((reply) => <div className={`comment-item support-reply ${reply.senderType}`} key={reply.id}><b>{reply.senderType === "staff" ? "운영자" : inquiry.author}</b><div className="rich-body support-reply-body" dangerouslySetInnerHTML={{ __html: renderRichBody(reply.body) }} /><time>{formatPostTime(reply.createdAt)}</time></div>)}
        {replies.length === 0 && <p className="comment-empty">아직 답변이 없습니다.</p>}
      </div>
      <SupportReplyComposer key={inquiry.id} submitting={submitting} onSend={onReply} />
    </section>
  </article>;
}

function HorizontalScrollRow({ className, label, children }: { className: string; label: string; children: ReactNode }) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const viewportId = useId();
  const [availability, setAvailability] = useState({ canScrollLeft: false, canScrollRight: false });

  const updateAvailability = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const next = horizontalScrollAvailability(viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth);
    setAvailability((current) => current.canScrollLeft === next.canScrollLeft && current.canScrollRight === next.canScrollRight ? current : next);
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const frame = window.requestAnimationFrame(updateAvailability);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateAvailability);
    observer?.observe(viewport);
    Array.from(viewport.children).forEach((child) => observer?.observe(child));
    window.addEventListener("resize", updateAvailability);
    return () => {
      window.cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", updateAvailability);
    };
  }, [updateAvailability]);

  const scroll = (direction: -1 | 1) => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const items = Array.from(viewport.children).map((child) => {
      const element = child as HTMLElement;
      return { left: element.offsetLeft, width: element.offsetWidth };
    });
    const left = horizontalScrollTarget(direction, viewport.scrollLeft, viewport.clientWidth, viewport.scrollWidth, items);
    const behavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
    viewport.scrollTo({ left, behavior });
  };

  return <div className={`horizontal-scroll-shell${availability.canScrollLeft ? " can-scroll-left" : ""}${availability.canScrollRight ? " can-scroll-right" : ""}`}>
    <div id={viewportId} ref={viewportRef} className={className} aria-label={label} onScroll={updateAvailability}>{children}</div>
    {availability.canScrollLeft && <button type="button" className="horizontal-scroll-arrow previous" aria-controls={viewportId} aria-label={`${label} 이전 항목 보기`} onClick={() => scroll(-1)}>‹</button>}
    {availability.canScrollRight && <button type="button" className="horizontal-scroll-arrow next" aria-controls={viewportId} aria-label={`${label} 다음 항목 보기`} onClick={() => scroll(1)}>›</button>}
  </div>;
}

function RegionSelector({ region, district, onSelectRegion, onSelectDistrict, compact = false }: {
  region: string;
  district: string;
  onSelectRegion: (region: string) => void;
  onSelectDistrict: (district: string) => void;
  compact?: boolean;
}) {
  const activeGroup = regionGroups.find((group) => group.label === region) ?? regionGroups[0];
  return <div className={`area-picker ${compact ? "compact" : ""}`}>
    <HorizontalScrollRow className="area-major-row" label="큰 지역 선택">
      {regionGroups.map((group) => (
        <button
          key={group.label}
          type="button"
          className={region === group.label ? "selected" : ""}
          onClick={() => onSelectRegion(group.label)}
        >
          {group.label}
        </button>
      ))}
    </HorizontalScrollRow>
    {activeGroup.label !== "전체" && activeGroup.districts.length > 0 && (
      <div className="area-minor-panel" aria-label={`${activeGroup.label} 소지역 선택`}>
        <button type="button" className={district === "전체" ? "selected" : ""} onClick={() => onSelectDistrict("전체")}>전체</button>
        {activeGroup.districts.map((item) => (
          <button
            key={item}
            type="button"
            className={district === item ? "selected" : ""}
            onClick={() => onSelectDistrict(item)}
          >
            {item}
          </button>
        ))}
      </div>
    )}
  </div>;
}

function VendorCategorySelector({ category, onSelect }: { category: string; onSelect: (category: string) => void }) {
  return <div className="vendor-category-picker">
    <HorizontalScrollRow className="vendor-category-row" label="업종 선택">
      {vendorCategories.map((item) => <button key={item} type="button" className={category === item ? "selected" : ""} onClick={() => onSelect(item)}>{item}</button>)}
    </HorizontalScrollRow>
  </div>;
}

function VendorSection({ posts, loading, onOpen, onMore }: { posts: FeaturedVendorPost[]; loading: boolean; onOpen: (post: FeaturedVendorPost) => void; onMore: () => void }) {
  return <section className="content-section page-width"><div className="section-heading"><div><p className="eyebrow">EDITOR&apos;S PICK</p><h2>추천 업체</h2></div><button onClick={onMore}>전체보기 <span>›</span></button></div><FeaturedVendorGrid posts={posts} loading={loading} onOpen={onOpen} /></section>;
}

function VendorTextBoard({ industry, region, district, search, viewerKey, onClearSearch, onLoginRequired, showToast }: {
  industry: string;
  region: string;
  district: string;
  search: string;
  viewerKey: string;
  onClearSearch: () => void;
  onLoginRequired: () => void;
  showToast: (message: string) => void;
}) {
  const [posts, setPosts] = useState<VendorTextPost[]>([]);
  const [canWrite, setCanWrite] = useState(false);
  const [assignments, setAssignments] = useState<VendorAssignment[]>([]);
  const [jumpSummary, setJumpSummary] = useState<VendorJumpSummary | null>(null);
  const [selected, setSelected] = useState<VendorTextPost | null>(null);
  const [writing, setWriting] = useState(false);
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [jumping, setJumping] = useState(false);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [writeIndustry, setWriteIndustry] = useState("");
  const [writeArea, setWriteArea] = useState("");
  const [writeTitle, setWriteTitle] = useState("");
  const [writeTitleColor, setWriteTitleColor] = useState<TitleColor>("");
  const [writeBody, setWriteBody] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const requestRef = useRef(0);

  const load = useCallback(async (cursor: number | null = null) => {
    const requestId = ++requestRef.current;
    if (cursor) setLoadingMore(true);
    else { setLoading(true); setLoadingMore(false); }
    try {
      const params = new URLSearchParams({ industry, region, district });
      if (search.trim()) params.set("q", search.trim());
      if (cursor) params.set("cursor", String(cursor));
      const response = await fetch(`/api/vendor-posts?${params}`, { cache: "no-store" });
      const result = await response.json() as { posts?: VendorTextPost[]; nextCursor?: number | null; canWrite?: boolean; assignedRegions?: VendorAssignment[]; jumpSummary?: VendorJumpSummary | null; error?: string };
      if (!response.ok) throw new Error(result.error ?? "업체정보 글을 불러오지 못했습니다.");
      if (requestRef.current !== requestId) return;
      setPosts((current) => cursor ? [...current, ...(result.posts ?? [])] : result.posts ?? []);
      setNextCursor(result.nextCursor ?? null);
      setCanWrite(Boolean(result.canWrite));
      setAssignments(result.assignedRegions ?? []);
      setJumpSummary(result.jumpSummary ?? null);
    } catch (error) { if (requestRef.current === requestId) showToast(error instanceof Error ? error.message : "업체정보 글을 불러오지 못했습니다."); }
    finally { if (requestRef.current === requestId) { if (cursor) setLoadingMore(false); else setLoading(false); } }
  }, [district, industry, region, search, showToast]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load, viewerKey]);

  const closeEditor = () => {
    if (editorBusy) return;
    setWriting(false); setEditing(false); setWriteIndustry(""); setWriteArea(""); setWriteTitle(""); setWriteTitleColor(""); setWriteBody("");
  };
  const openWrite = () => {
    if (!viewerKey) { onLoginRequired(); showToast("로그인 후 업체정보 글을 작성할 수 있습니다."); return; }
    if (!canWrite) { showToast("업체정보 글은 실장 계정만 작성할 수 있습니다."); return; }
    setSelected(null); setEditing(false); setWriting(true);
    setWriteIndustry(industry === "전체" ? "" : industry); setWriteArea(""); setWriteTitle(""); setWriteTitleColor(""); setWriteBody("");
  };
  const openPost = async (post: VendorTextPost) => {
    try {
      const response = await fetch(`/api/vendor-posts/${post.id}`, { cache: "no-store" });
      const result = await response.json() as { post?: VendorTextPost; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "업체정보 글을 불러오지 못했습니다.");
      setSelected(result.post); setWriting(false); setEditing(false);
    } catch (error) { showToast(error instanceof Error ? error.message : "업체정보 글을 불러오지 못했습니다."); }
  };
  const beginEdit = () => {
    if (!selected?.canEdit) return;
    setWriteIndustry(selected.industry); setWriteArea(`${selected.region}::${selected.district}`); setWriteTitle(selected.title); setWriteTitleColor(selected.titleColor || ""); setWriteBody(selected.body); setEditing(true); setWriting(false);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || editorBusy) return;
    const [nextRegion = "", nextDistrict = ""] = writeArea.split("::");
    setSubmitting(true);
    try {
      const endpoint = editing && selected ? `/api/vendor-posts/${selected.id}` : "/api/vendor-posts";
      const response = await fetch(endpoint, { method: editing ? "PATCH" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ industry: writeIndustry, region: nextRegion, district: nextDistrict, title: writeTitle, titleColor: writeTitleColor, body: writeBody }) });
      const result = await response.json() as { post?: VendorTextPost; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "업체정보 글을 저장하지 못했습니다.");
      setSelected(result.post); setEditing(false); setWriting(false); showToast(editing ? "업체정보 글을 수정했습니다." : "업체정보 글을 등록했습니다."); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "업체정보 글을 저장하지 못했습니다."); }
    finally { setSubmitting(false); }
  };
  const remove = async () => {
    if (!selected?.canDelete || submitting || !window.confirm("이 업체정보 글을 삭제하시겠습니까?")) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/vendor-posts/${selected.id}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "업체정보 글을 삭제하지 못했습니다.");
      setSelected(null); showToast("업체정보 글을 삭제했습니다."); await load();
    } catch (error) { showToast(error instanceof Error ? error.message : "업체정보 글을 삭제하지 못했습니다."); }
    finally { setSubmitting(false); }
  };
  const jumpToTop = async () => {
    if (jumping) return;
    if (!viewerKey) { onLoginRequired(); showToast("로그인 후 상단점프를 사용할 수 있습니다."); return; }
    if (!canWrite || assignments.length === 0) { showToast("담당 상세지역이 있는 실장만 상단점프를 사용할 수 있습니다."); return; }
    if ((jumpSummary?.remaining ?? 0) <= 0) { showToast("오늘 사용할 수 있는 상단점프 횟수를 모두 사용했습니다."); return; }
    setJumping(true);
    try {
      const response = await fetch("/api/vendor-posts/jump", { method: "POST" });
      const result = await response.json() as { jumpSummary?: VendorJumpSummary; error?: string };
      if (!response.ok || !result.jumpSummary) throw new Error(result.error ?? "상단점프를 처리하지 못했습니다.");
      setJumpSummary(result.jumpSummary);
      showToast(`상단점프 완료 · ${result.jumpSummary.remaining}회 남았습니다.`);
      await load();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "상단점프를 처리하지 못했습니다.");
    } finally {
      setJumping(false);
    }
  };

  const availableAssignments = assignments.filter((item) => !item.used);
  const canJump = canWrite && assignments.length > 0;
  if (writing || editing) return <section className="vendor-text-board vendor-editor">
    <div className="vendor-board-title"><div><p>VENDOR BOARD</p><h2>{editing ? "업체정보 수정" : "업체정보 등록"}</h2></div><button type="button" onClick={closeEditor}>목록</button></div>
    <form onSubmit={submit}>
      <fieldset><legend>업종 <small>하나만 선택</small></legend><div className="vendor-choice-grid categories">{writableVendorCategories.map((item) => <label key={item}><input type="radio" name="vendorIndustry" checked={writeIndustry === item} onChange={() => setWriteIndustry(item)} /><span>{item}</span></label>)}</div></fieldset>
      <fieldset><legend>상세지역 <small>{editing ? "등록 후에는 변경할 수 없습니다." : "배정받은 지역 중 하나만 선택"}</small></legend>
        {editing && selected ? <div className="vendor-fixed-area"><b>{selected.region}</b><span>{selected.district}</span></div> : <div className="vendor-choice-grid regions">{assignments.map((item) => { const key = `${item.region}::${item.district}`; return <label key={key} className={item.used ? "used" : ""}><input type="radio" name="vendorArea" disabled={Boolean(item.used)} checked={writeArea === key} onChange={() => setWriteArea(key)} /><span><b>{item.region}</b>{item.district}<small>{item.used ? "작성 완료" : "선택 가능"}</small></span></label>; })}</div>}
        {!editing && assignments.length === 0 && <p className="vendor-assignment-empty">관리자에게 담당 상세지역을 배정받은 뒤 등록할 수 있습니다.</p>}
        {!editing && assignments.length > 0 && availableAssignments.length === 0 && <p className="vendor-assignment-empty">배정된 모든 상세지역에 글을 등록했습니다.</p>}
      </fieldset>
      <RichTitleInput value={writeTitle} onChange={setWriteTitle} placeholder="업체정보 제목을 입력해 주세요." ariaLabel="업체정보 제목" />
      <RichTextEditor name="vendorBody" value={writeBody} onChange={setWriteBody} onBusyChange={setEditorBusy} allowPoll={false} placeholder="업체 소개와 안내 내용을 입력해 주세요." />
      <div className="vendor-editor-actions"><button type="button" disabled={editorBusy} onClick={closeEditor}>취소</button><button type="submit" disabled={submitting || editorBusy || !writeIndustry || !writeArea || !writeTitle.trim()}>{editorBusy ? "첨부 중…" : submitting ? "저장 중…" : editing ? "수정 완료" : "등록"}</button></div>
    </form>
  </section>;

  if (selected) return <section className="vendor-text-board vendor-detail">
    <div className="vendor-board-title"><div><p>VENDOR BOARD</p><h2><PostTitleText title={selected.title} titleColor={selected.titleColor} /></h2></div><button type="button" onClick={() => setSelected(null)}>목록</button></div>
    <div className="vendor-detail-meta"><span>{selected.industry}</span><span>{selected.region}</span><span>{selected.district}</span><small>Lv.{selected.authorLevel} {selected.author} · {formatPostTime(selected.updatedAt)}</small></div>
    <div className="rich-post-body" dangerouslySetInnerHTML={{ __html: renderRichBody(selected.body) }} />
    <div className="vendor-detail-actions">{selected.canEdit && <button type="button" onClick={beginEdit}>수정</button>}{selected.canDelete && <button type="button" className="danger" disabled={submitting} onClick={() => void remove()}>삭제</button>}<button type="button" onClick={() => setSelected(null)}>목록</button></div>
  </section>;

  return <section className="vendor-text-board">
    <div className="vendor-board-title">
      <div><p>VENDOR BOARD</p><h2>{search ? `“${search}” 검색 결과` : "지역별 업체정보"}</h2></div>
      <div className="vendor-board-actions">
        {search && <button type="button" onClick={onClearSearch}>전체 목록</button>}
        {canJump && <div className="vendor-jump-tools">
          <small>{jumpSummary?.resetText ?? "00시00분에 새롭게 갱신 됩니다"}</small>
          <button type="button" className="jump" disabled={jumping || (jumpSummary?.remaining ?? 0) <= 0} onClick={() => void jumpToTop()}>{jumping ? "상단점프 중…" : `상단점프 ${jumpSummary?.remaining ?? 0}회`}</button>
        </div>}
        {canWrite && <button type="button" className="write" onClick={openWrite}>글쓰기</button>}
      </div>
    </div>
    <div className="vendor-board-table" role="table" aria-label="지역별 업체정보 목록">
      <div className="vendor-board-head" role="row"><span role="columnheader">업종</span><span role="columnheader">지역</span><span role="columnheader">상세</span><b role="columnheader">제목</b></div>
      <div className="vendor-board-list">{loading ? <p className="vendor-board-empty">불러오는 중…</p> : posts.length ? posts.map((post) => <button type="button" className="vendor-board-row" aria-label={`${post.industry} ${post.region} ${post.district} ${stripRichTitle(post.title)} 업체정보 보기`} key={post.id} onClick={() => void openPost(post)}><span>{post.industry}</span><span>{post.region}</span><span>{post.district}</span><span className="vendor-board-subject"><PostTitleText title={post.title} titleColor={post.titleColor} /></span></button>) : <p className="vendor-board-empty">{search ? "검색 조건에 맞는 업체정보 글이 없습니다." : "조건에 맞는 업체정보 글이 없습니다."}</p>}</div>
    </div>
    {nextCursor && <button className="vendor-board-more" type="button" disabled={loadingMore} onClick={() => void load(nextCursor)}>{loadingMore ? "불러오는 중…" : "이전 업체정보 더보기"}</button>}
  </section>;
}

function PostTitleText({ title, titleColor }: { title: string; titleColor?: string }) {
  return <span className="post-title-text" style={titleColor ? { color: titleColor } : undefined} dangerouslySetInnerHTML={{ __html: renderRichTitle(title) }} />;
}

function CommunityPostTitle({ category, title, titleColor, tags }: { category: string; title: string; titleColor?: string; tags?: readonly CommunityTag[] }) {
  if (!isCommunityBoardCategory(category)) return <PostTitleText title={title} titleColor={titleColor} />;
  const visibleTags = tags?.length ? tags : (["일상"] as const);
  return <><span className="community-title-tags" aria-label={`머릿글 ${visibleTags.join(", ")}`}>{visibleTags.join(" ")}</span><PostTitleText title={title} titleColor={titleColor} /></>;
}

function BoardPreview({ kind, title, posts, onMore }: { kind: BoardKind; title: string; posts: ReturnType<typeof boardPosts>; onMore: () => void }) {
  return <section className="board-card"><div className="section-heading compact"><h2>{title}</h2><button onClick={onMore}>더보기 <span>›</span></button></div><div className="preview-posts">{posts.map((post, index) => <button key={post.id} onClick={onMore}><span className={`post-mark ${index === 0 ? "hot" : ""}`}>{index === 0 ? "HOT" : String(index + 1).padStart(2, "0")}</span><b><CommunityPostTitle category={kind} title={post.title} titleColor={post.titleColor} tags={post.communityTags} /></b><small>{post.time}</small></button>)}</div></section>;
}

function formatPostTime(createdAt: string) {
  const created = new Date(createdAt);
  const elapsedMinutes = Math.max(0, Math.floor((Date.now() - created.getTime()) / 60000));
  if (elapsedMinutes < 1) return "방금 전";
  if (elapsedMinutes < 60) return `${elapsedMinutes}분 전`;
  if (elapsedMinutes < 1440) return `${Math.floor(elapsedMinutes / 60)}시간 전`;
  return new Intl.DateTimeFormat("ko-KR", { month: "2-digit", day: "2-digit" }).format(created);
}

const formatPostAuthor = (post: Pick<BoardDisplayPost, "author" | "authorLevel">) => post.authorLevel > 0 ? `Lv.${post.authorLevel} ${post.author}` : post.author;
const supportStatusLabel = (status: SupportInquiry["status"]) => status === "answered" ? "답변완료" : status === "closed" ? "종료" : "접수";
const pointTypeLabel = (type: string) => type === "attendance" ? "출석체크" : type === "attendance_streak_reward" ? "개근보상" : type === "post_create" ? "글작성 보상" : type === "review_create" ? "후기작성 보상" : type === "comment_create" ? "댓글작성 보상" : type === "event_reward" ? "이벤트 보상" : type === "shop_purchase" ? "상점 구매" : type === "adjustment" ? "관리자 조정" : type === "discount" ? "할인 사용" : "포인트";
const formatPointDate = (value: string) => new Intl.DateTimeFormat("ko-KR", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
}).format(new Date(value));

type BoardPageProps = {
  kind: BoardKind;
  livePosts: LivePost[];
  viewer: Viewer | null;
  writing: boolean;
  selectedPost: BoardDisplayPost | null;
  submitting: boolean;
  onWrite: () => void;
  onCancelWrite: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onOpen: (post: BoardDisplayPost) => void;
  onLoginRequired: () => void;
  onPostChange: (post: BoardDisplayPost) => void;
  onPostRemoved: (postId: number) => void;
  onPointReward: (points: number) => void;
  showToast: (message: string) => void;
  hideHeading?: boolean;
};

const boardLabels: Record<BoardKind, string> = { notices: "공지사항", reviews: "후기", events: "이벤트", gifs: "커뮤니티", community: "커뮤니티" };
const BOARD_PAGE_SIZE = 20;

function formatEventDateTime(value: string, end = false) {
  const date = new Date(value);
  if (end) date.setSeconds(date.getSeconds() - 1);
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

function EventPage(props: BoardPageProps) {
  const [period, setPeriod] = useState<EventPeriod>("weekly");
  const [data, setData] = useState<EventLeaderboardData | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`/api/events/leaderboard?period=${period}`, { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as EventLeaderboardData & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "이벤트 랭킹을 불러오지 못했습니다.");
      if (active) setData(result);
    }).catch(() => {
      if (active) setData(null);
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [period]);

  const changePeriod = (next: EventPeriod) => {
    if (next === period) return;
    setLoading(true);
    setPeriod(next);
  };

  return <section className="event-page page-width">
    <div className="forum-heading compact-forum-heading event-heading">
      <p className="eyebrow">EVENT RANKING</p>
      <h1>이벤트</h1>
      <p>글쓰기왕과 댓글왕을 주간·월간으로 집계하고 상위 3명에게 추가 포인트를 지급합니다.</p>
    </div>

    <div className="event-rank-shell">
      <div className="event-rank-top">
        <div>
          <strong>랭킹 집계표</strong>
          <span>{data ? `${formatEventDateTime(data.period.startAt)} ~ ${formatEventDateTime(data.period.endAt, true)}` : "집계 기간을 불러오는 중입니다."}</span>
        </div>
        <div className="event-period-tabs" role="tablist" aria-label="이벤트 집계 기간">
          <button type="button" className={period === "weekly" ? "active" : ""} onClick={() => changePeriod("weekly")}>주간</button>
          <button type="button" className={period === "monthly" ? "active" : ""} onClick={() => changePeriod("monthly")}>월간</button>
        </div>
      </div>

      <div className="event-rank-grid">
        <EventRankTable title="글쓰기왕" description="후기·커뮤니티 작성글 기준" activityLabel="작성글" rows={data?.posts ?? []} loading={loading} unit="글" />
        <EventRankTable title="댓글왕" description="댓글 수 + 출석체크 1회 포함" activityLabel="댓글수" rows={data?.comments ?? []} loading={loading} unit="개" />
      </div>
      <p className="event-rank-note">보상은 집계 기간 종료 후 자동 지급됩니다. 1·2·3등만 포인트가 지급되고, 출석체크는 댓글왕 집계에 1회로 포함됩니다.</p>
    </div>

    <div className="event-posts-heading">
      <p className="eyebrow">EVENT BOARD</p>
      <h2>진행 이벤트</h2>
      <span>관리자가 등록한 이벤트 안내글입니다.</span>
    </div>
    <BoardPage {...props} hideHeading />
  </section>;
}

function EventRankTable({ title, description, activityLabel, rows, loading, unit }: { title: string; description: string; activityLabel: string; rows: EventRankRow[]; loading: boolean; unit: string }) {
  const byRank = new Map(rows.map((row) => [row.rank, row]));
  return <article className="event-rank-card">
    <header><div><h2>{title}</h2><p>{description}</p></div><span>TOP 10</span></header>
    <div className="event-rank-table" role="table" aria-label={`${title} 순위`}>
      <div className="event-rank-row event-rank-head" role="row"><span>순위</span><b>닉네임</b><span>{activityLabel}</span><span>보상</span></div>
      {Array.from({ length: 10 }, (_, index) => {
        const rank = index + 1;
        const row = byRank.get(rank);
        return <div className={`event-rank-row rank-${rank}`} role="row" key={rank}>
          <span>{rank <= 3 ? ["🥇", "🥈", "🥉"][rank - 1] : rank}</span>
          <b>{row ? <><em>Lv.{row.level}</em>{row.nickname}</> : loading ? "집계 중" : "집계 대기"}</b>
          <span>{row ? `${row.count.toLocaleString()}${unit}` : "-"}</span>
          <span>{row?.rewardPoints ? <strong>+{row.rewardPoints.toLocaleString()}P{row.paid ? " 지급" : ""}</strong> : "-"}</span>
        </div>;
      })}
    </div>
  </article>;
}

function BoardPage({ kind, livePosts, viewer, writing, selectedPost, submitting, onWrite, onCancelWrite, onSubmit, onOpen, onLoginRequired, onPostChange, onPostRemoved, onPointReward, showToast, hideHeading = false }: BoardPageProps) {
  const [filter, setFilter] = useState<"all" | "popular" | "notice">("all");
  const [searchInput, setSearchInput] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [popularNow, setPopularNow] = useState(0);
  const [popularLivePosts, setPopularLivePosts] = useState<LivePost[] | null>(null);
  const [popularLoading, setPopularLoading] = useState(false);
  const [currentPage, setCurrentPage] = useState(1);
  const popularRequestRef = useRef(0);
  const changeFilter = (nextFilter: "all" | "popular" | "notice") => {
    setCurrentPage(1);
    if (nextFilter === "popular") {
      setPopularNow(Date.now());
      const requestId = ++popularRequestRef.current;
      setPopularLoading(true);
      fetch(`/api/posts?category=${kind}&sort=popular`, { cache: "no-store" }).then(async (response) => {
        const result = await response.json() as { posts?: LivePost[]; error?: string };
        if (!response.ok) throw new Error(result.error ?? "인기글을 불러오지 못했습니다.");
        if (popularRequestRef.current === requestId) setPopularLivePosts(result.posts ?? []);
      }).catch((error) => {
        if (popularRequestRef.current === requestId) showToast(error instanceof Error ? error.message : "인기글을 불러오지 못했습니다.");
      }).finally(() => {
        if (popularRequestRef.current === requestId) setPopularLoading(false);
      });
    }
    setFilter(nextFilter);
  };
  const toDisplayPost = (post: LivePost): BoardDisplayPost => ({
    id: post.id, title: post.title, titleColor: post.titleColor || "", body: post.body, communityTags: post.communityTags, author: post.author, authorLevel: post.authorLevel,
    time: formatPostTime(post.createdAt), views: post.views, likes: post.likes, dislikes: post.dislikes ?? 0,
    reportCount: post.reportCount ?? 0, isNotice: Boolean(post.isNotice), isPinned: Boolean(post.isPinned), commentCount: post.commentCount ?? 0,
    isOwn: post.isOwn, canEdit: post.canEdit, canDelete: post.canDelete, createdAt: post.createdAt, live: true,
  });
  const memberPosts = livePosts.map(toDisplayPost);
  const popularMembers = (popularLivePosts ?? livePosts).map(toDisplayPost);
  const samplePosts = boardPosts(kind);
  const allPosts = [...memberPosts, ...samplePosts].sort((left, right) =>
    Number(right.isPinned) - Number(left.isPinned)
    || Number(right.isNotice) - Number(left.isNotice)
    || postCreatedTime(right) - postCreatedTime(left));
  const popularPosts = popularMembers
    .filter((post) => !post.isNotice && popularNow > 0 && isInPopularWindow(post, popularNow))
    .sort(comparePopularPosts);
  const sourcePosts = filter === "popular" ? popularPosts : allPosts;
  const searchedPosts = sourcePosts.filter((post) => !searchTerm || `${post.communityTags.join(" ")} ${stripRichTitle(post.title)} ${post.author}`.toLowerCase().includes(searchTerm.toLowerCase()));
  const filteredPosts = searchedPosts.filter((post) => filter !== "notice" || post.isNotice);
  const totalPages = Math.max(1, Math.ceil(filteredPosts.length / BOARD_PAGE_SIZE));
  const activePage = Math.min(currentPage, totalPages);
  const visiblePages = visiblePageNumbers(activePage, totalPages);
  const pageStart = (activePage - 1) * BOARD_PAGE_SIZE;
  const pagePosts = filteredPosts.slice(pageStart, pageStart + BOARD_PAGE_SIZE);
  const changePost = (post: BoardDisplayPost) => {
    onPostChange(post);
    if (typeof post.id !== "number") return;
    setPopularLivePosts((current) => current?.map((item) => item.id === post.id ? {
      ...item,
      title: post.title,
      titleColor: post.titleColor,
      body: post.body,
      communityTags: post.communityTags,
      views: post.views,
      likes: post.likes,
      dislikes: post.dislikes,
      reportCount: post.reportCount,
      isNotice: post.isNotice,
      isPinned: post.isPinned,
      commentCount: post.commentCount,
      isOwn: post.isOwn,
      canEdit: post.canEdit,
      canDelete: post.canDelete,
    } : item) ?? current);
  };
  const removePost = (postId: number) => {
    onPostRemoved(postId);
    setPopularLivePosts((current) => current?.filter((item) => item.id !== postId) ?? current);
  };

  const headingLead = kind === "notices" ? "운영 공지와 필수 안내를 한곳에서 확인하세요."
    : kind === "reviews" ? "최근 이용자가 남긴 생생한 후기를 확인하세요."
    : kind === "events" ? "놓치면 아쉬운 혜택과 새로운 소식을 전합니다."
    : "자유롭게 정보를 나누되 서로를 존중해 주세요.";
  return <section className={`board-page page-width ${hideHeading ? "embedded-board-page" : "compact-board-page"}`}>
    {!hideHeading && <div className="forum-heading compact-forum-heading"><p className="eyebrow">{kind === "notices" ? "NOTICE" : "COMMUNITY"}</p><h1>{boardLabels[kind]}</h1><p>{headingLead}</p></div>}
    {writing ? <BoardWritePage kind={kind} viewer={viewer} onCancel={onCancelWrite} onSubmit={onSubmit} submitting={submitting} /> : <>
      {selectedPost && <BoardDetail key={selectedPost.id} kind={kind} post={selectedPost} viewer={viewer} onLoginRequired={onLoginRequired} onPostChange={changePost} onPostRemoved={removePost} onPointReward={onPointReward} showToast={showToast} />}
      <BoardList kind={kind} posts={pagePosts} totalPosts={filteredPosts.length} pageStart={pageStart} filter={filter} loading={filter === "popular" && popularLoading} onFilter={changeFilter} onWrite={onWrite} onOpen={onOpen} />
      <div className="forum-bottom">
        <div className="forum-pagination" aria-label={`${boardLabels[kind]} 페이지 이동`}>
          <button type="button" aria-label="이전 페이지" disabled={activePage === 1} onClick={() => setCurrentPage(Math.max(1, activePage - 1))}>‹</button>
          {visiblePages.map((page) => <button type="button" className={page === activePage ? "active" : ""} aria-current={page === activePage ? "page" : undefined} onClick={() => setCurrentPage(page)} key={page}>{page}</button>)}
          <button type="button" aria-label="다음 페이지" disabled={activePage === totalPages} onClick={() => setCurrentPage(Math.min(totalPages, activePage + 1))}>›</button>
        </div>
        {kind !== "events" && kind !== "notices" && <button type="button" className="forum-write-button" onClick={onWrite}>글쓰기</button>}
      </div>
      <form className="forum-search" onSubmit={(event) => { event.preventDefault(); setCurrentPage(1); setSearchTerm(searchInput.trim()); }}>
        <select aria-label="검색 범위" defaultValue="title"><option value="title">제목</option><option value="titleAuthor">제목+작성자</option></select>
        <input value={searchInput} onChange={(event) => setSearchInput(event.target.value)} aria-label="게시판 검색어" />
        <button type="submit">검색</button>
      </form>
    </>}
  </section>;
}

function BoardList({ kind, posts, totalPosts, pageStart, filter, loading, onFilter, onWrite, onOpen }: { kind: BoardKind; posts: BoardDisplayPost[]; totalPosts: number; pageStart: number; filter: "all" | "popular" | "notice"; loading: boolean; onFilter: (next: "all" | "popular" | "notice") => void; onWrite: () => void; onOpen: (post: BoardDisplayPost) => void }) {
  return <>
    <div className="forum-toolbar"><div><button className={filter === "all" ? "selected" : ""} onClick={() => onFilter("all")}>전체글</button>{kind !== "events" && kind !== "notices" && <button className={filter === "popular" ? "selected" : ""} onClick={() => onFilter("popular")}>인기글</button>}</div>{kind !== "events" && kind !== "notices" && <button className="forum-write-button" onClick={onWrite}>글쓰기</button>}</div>
    <div className="forum-table" role="table" aria-label={`${boardLabels[kind]} 글 목록`} aria-busy={loading}>
      <div className="forum-row forum-head" role="row"><span>번호</span><b>제목</b><span>글쓴이</span><span>작성일</span><span>조회</span><span>추천</span><span>비추천</span></div>
      {posts.map((post, index) => <button type="button" className="forum-row" key={post.id} onClick={() => onOpen(post)}>
        <span>{kind === "notices" ? totalPosts - pageStart - index : post.isPinned ? <em className="pinned-mark">고정</em> : post.isNotice ? <em className="notice-mark">공지</em> : post.live ? "NEW" : totalPosts - pageStart - index}</span><b><CommunityPostTitle category={kind} title={post.title} titleColor={post.titleColor} tags={post.communityTags} />{post.commentCount > 0 && <em>[{post.commentCount}]</em>}<small>{formatPostAuthor(post)} · {post.time}</small></b><span>{formatPostAuthor(post)}</span><span>{post.time}</span><span>{post.views}</span><span>{post.likes}</span><span>{post.dislikes}</span>
      </button>)}
      {loading && posts.length === 0 ? <div className="forum-empty">최근 7일 인기글을 불러오는 중입니다.</div> : posts.length === 0 && <div className="forum-empty">조건에 맞는 게시글이 없습니다.</div>}
    </div>
  </>;
}

function CommunityTagPicker({ value, onChange }: { value: readonly CommunityTag[]; onChange: (tags: CommunityTag[]) => void }) {
  const toggle = (tag: CommunityTag) => {
    const selected = new Set(value);
    if (selected.has(tag)) selected.delete(tag);
    else selected.add(tag);
    onChange(COMMUNITY_TAGS.filter((candidate) => selected.has(candidate)));
  };

  return <fieldset className="community-tag-picker" aria-required="true">
    <legend>머릿글 선택 <em>필수 · 1개 이상</em></legend>
    <div className="community-tag-options">
      {COMMUNITY_TAGS.map((tag) => <label className="community-tag-option" key={tag}>
        <input type="checkbox" name="communityTags" value={tag} checked={value.includes(tag)} onChange={() => toggle(tag)} />
        <span>{tag}</span>
      </label>)}
    </div>
  </fieldset>;
}

function TitleColorPicker({ value, onChange }: { value: TitleColor; onChange: (color: TitleColor) => void }) {
  return <fieldset className="title-color-picker">
    <legend>제목 색상</legend>
    <div className="title-color-options">
      {TITLE_COLOR_OPTIONS.map((option) => <label className={value === option.value ? "selected" : ""} key={option.label}>
        <input type="radio" name="titleColor" value={option.value} checked={value === option.value} onChange={() => onChange(option.value)} />
        <span><i style={{ background: option.value || "#111111" }} />{option.label}</span>
      </label>)}
    </div>
  </fieldset>;
}

function BoardWritePage({ kind, viewer, onCancel, onSubmit, submitting }: { kind: BoardKind; viewer: Viewer | null; onCancel: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; submitting: boolean }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [communityTags, setCommunityTags] = useState<CommunityTag[]>([]);
  return <form className="forum-write" onSubmit={(event) => { if (editorBusy) { event.preventDefault(); return; } onSubmit(event); }}>
    <div className="forum-write-title"><strong>{boardLabels[kind]} 글쓰기</strong><span>건강한 게시판 문화를 함께 만들어 주세요.</span></div>
    {isCommunityBoardCategory(kind) && <CommunityTagPicker value={communityTags} onChange={setCommunityTags} />}
    <RichTitleInput name="title" value={title} onChange={setTitle} autoFocus placeholder="제목을 입력해 주세요." />
    {viewer?.level === 10 && (kind === "community" || kind === "reviews") && <label className="forum-pin-option"><input type="checkbox" name="isPinned" /> <span><b>상단 고정</b><small>체크하면 게시판 최상단에 고정됩니다.</small></span></label>}
    <RichTextEditor name="body" value={body} onChange={setBody} onBusyChange={setEditorBusy} placeholder="내용을 입력해 주세요." />
    <div className="forum-write-actions"><button type="button" disabled={editorBusy} onClick={onCancel}>취소</button><button type="submit" disabled={submitting || editorBusy}>{editorBusy ? "첨부 중…" : submitting ? "등록 중…" : "등록"}</button></div>
  </form>;
}

function BoardDetail({ kind, post: initialPost, viewer, onLoginRequired, onPostChange, onPostRemoved, onPointReward, showToast }: { kind: BoardKind; post: BoardDisplayPost; viewer: Viewer | null; onLoginRequired: () => void; onPostChange: (post: BoardDisplayPost) => void; onPostRemoved: (postId: number) => void; onPointReward: (points: number) => void; showToast: (message: string) => void }) {
  const [post, setPost] = useState(initialPost);
  const [comments, setComments] = useState<PostComment[]>([]);
  const [commentBody, setCommentBody] = useState("");
  const [sort, setSort] = useState<"old" | "new">("old");
  const [submitting, setSubmitting] = useState(false);
  const [reportOpen, setReportOpen] = useState(false);
  const [actionSubmitting, setActionSubmitting] = useState(false);
  const [poll, setPoll] = useState<PostPoll | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(initialPost.title);
  const [editTitleColor, setEditTitleColor] = useState<TitleColor>((initialPost.titleColor || "") as TitleColor);
  const [editBody, setEditBody] = useState(initialPost.body);
  const [editBusy, setEditBusy] = useState(false);
  const [editPinned, setEditPinned] = useState(Boolean(initialPost.isPinned));
  const [editCommunityTags, setEditCommunityTags] = useState<CommunityTag[]>(initialPost.communityTags);

  useEffect(() => {
    if (!initialPost.live || typeof initialPost.id !== "number") return;
    let active = true;
    fetch(`/api/posts/${initialPost.id}`, { cache: "no-store" }).then(async (response) => {
      const result = await response.json() as { post?: LivePost; comments?: PostComment[]; poll?: PostPoll | null; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "게시글을 불러오지 못했습니다.");
      if (!active) return;
      const next = { ...initialPost, ...result.post, time: formatPostTime(result.post.createdAt), live: true };
      setPost(next);
      setEditTitle(next.title);
      setEditTitleColor((next.titleColor || "") as TitleColor);
      setEditBody(next.body);
      setEditPinned(Boolean(next.isPinned));
      setEditCommunityTags(next.communityTags);
      setComments(result.comments ?? []);
      setPoll(result.poll ?? null);
      onPostChange(next);
    }).catch((error) => { if (active) showToast(error instanceof Error ? error.message : "게시글을 불러오지 못했습니다."); });
    return () => { active = false; };
    // 게시글 번호나 로그인 사용자가 바뀔 때 상세 권한을 다시 조회합니다. 부모 콜백 변경은 재조회를 유발하지 않습니다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialPost.id, viewer?.nickname, viewer?.level]);

  const vote = async (voteType: "up" | "down", basePost = post) => {
    if (!viewer) { onLoginRequired(); showToast("로그인 후 추천 또는 비추천할 수 있습니다."); return false; }
    if (basePost.isOwn || basePost.author === viewer.nickname) { showToast("본인 게시글에는 추천이나 비추천을 할 수 없습니다."); return false; }
    if (!basePost.live || typeof basePost.id !== "number") { showToast("샘플 게시글에는 투표할 수 없습니다."); return false; }
    const response = await fetch(`/api/posts/${basePost.id}/recommend`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ vote: voteType }) });
    const result = await response.json() as { likes?: number; dislikes?: number; reportCount?: number; autoDeleted?: boolean; error?: string };
    if (!response.ok) { showToast(result.error ?? "추천 또는 비추천을 처리하지 못했습니다."); return false; }
    if (result.autoDeleted) { onPostRemoved(basePost.id); showToast("누적 평가 기준에 따라 게시글이 자동 삭제되었습니다."); return true; }
    const next = { ...basePost, likes: result.likes ?? basePost.likes, dislikes: result.dislikes ?? basePost.dislikes, reportCount: result.reportCount ?? basePost.reportCount };
    setPost(next); onPostChange(next); showToast(voteType === "up" ? "게시글을 추천했습니다." : "게시글을 비추천했습니다."); return true;
  };

  const report = async (reason: "무단 홍보" | "사기" | "도배") => {
    if (!viewer) { onLoginRequired(); showToast("로그인 후 신고할 수 있습니다."); return; }
    if (!post.live || typeof post.id !== "number") { showToast("샘플 게시글에는 신고할 수 없습니다."); return; }
    setActionSubmitting(true);
    try {
      const response = await fetch(`/api/posts/${post.id}/report`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason }) });
      const result = await response.json() as { likes?: number; dislikes?: number; reportCount?: number; autoDeleted?: boolean; error?: string };
      if (!response.ok) throw new Error(result.error ?? "신고를 처리하지 못했습니다.");
      setReportOpen(false);
      if (result.autoDeleted) { onPostRemoved(post.id); showToast("신고가 접수되었으며 누적 평가 기준에 따라 글이 자동 삭제되었습니다."); return; }
      const next = { ...post, likes: result.likes ?? post.likes, dislikes: result.dislikes ?? post.dislikes, reportCount: result.reportCount ?? post.reportCount };
      setPost(next); onPostChange(next); showToast(`${reason} 사유로 신고가 접수되었습니다.`);
    } catch (error) { showToast(error instanceof Error ? error.message : "신고를 처리하지 못했습니다."); }
    finally { setActionSubmitting(false); }
  };

  const deletePost = async () => {
    if (!post.live || typeof post.id !== "number") { showToast("샘플 게시글은 삭제할 수 없습니다."); return; }
    if (!window.confirm("이 게시글을 삭제하시겠습니까? 삭제 후 복구할 수 없습니다.")) return;
    setActionSubmitting(true);
    try {
      const response = await fetch(`/api/posts/${post.id}`, { method: "DELETE" });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? "게시글을 삭제하지 못했습니다.");
      onPostRemoved(post.id); showToast("게시글을 삭제했습니다.");
    } catch (error) { showToast(error instanceof Error ? error.message : "게시글을 삭제하지 못했습니다."); }
    finally { setActionSubmitting(false); }
  };

  const submitEdit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!post.canEdit || !post.live || typeof post.id !== "number" || actionSubmitting || editBusy) return;
    if (isCommunityBoardCategory(kind) && editCommunityTags.length === 0) {
      showToast("머릿글을 하나 이상 선택해 주세요.");
      return;
    }
    setActionSubmitting(true);
    try {
      const response = await fetch(`/api/posts/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle, titleColor: editTitleColor, body: editBody, isPinned: editPinned, ...(isCommunityBoardCategory(kind) ? { communityTags: editCommunityTags } : {}) }),
      });
      const result = await response.json() as { post?: LivePost; error?: string };
      if (!response.ok || !result.post) throw new Error(result.error ?? "게시글을 수정하지 못했습니다.");
      const next = { ...post, ...result.post, time: formatPostTime(result.post.createdAt), live: true };
      setPost(next);
      setEditTitle(next.title);
      setEditTitleColor((next.titleColor || "") as TitleColor);
      setEditBody(next.body);
      setEditPinned(Boolean(next.isPinned));
      setEditCommunityTags(next.communityTags);
      setEditing(false);
      onPostChange(next);
      showToast("게시글을 수정했습니다.");
    } catch (error) { showToast(error instanceof Error ? error.message : "게시글을 수정하지 못했습니다."); }
    finally { setActionSubmitting(false); }
  };

  const submitComment = async (alsoRecommend = false) => {
    if (!viewer) { onLoginRequired(); showToast("로그인 후 댓글을 작성할 수 있습니다."); return; }
    if (!post.live || typeof post.id !== "number") { showToast("샘플 게시글에는 댓글을 등록할 수 없습니다."); return; }
    const normalized = commentBody.trim();
    if (!normalized) { showToast("댓글 내용을 입력해 주세요."); return; }
    setSubmitting(true);
    try {
      const response = await fetch(`/api/posts/${post.id}/comments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: normalized }) });
      const result = await response.json() as { comment?: PostComment; earnedPoints?: number; error?: string };
      if (!response.ok || !result.comment) throw new Error(result.error ?? "댓글을 저장하지 못했습니다.");
      setComments((current) => [...current, result.comment!]);
      setCommentBody("");
      const next = { ...post, commentCount: post.commentCount + 1 };
      setPost(next); onPostChange(next);
      if ((result.earnedPoints ?? 0) > 0) {
        onPointReward(result.earnedPoints ?? 0);
        showToast(`댓글이 등록되었습니다. +${(result.earnedPoints ?? 0).toLocaleString()}P`);
      } else {
        showToast("댓글이 등록되었습니다.");
      }
      if (alsoRecommend) await vote("up", next);
    } catch (error) { showToast(error instanceof Error ? error.message : "댓글을 저장하지 못했습니다."); }
    finally { setSubmitting(false); }
  };

  const sortedComments = sort === "old" ? comments : [...comments].reverse();
  if (editing) return <article className="forum-detail forum-edit-detail">
    <form className="forum-write forum-edit-form" onSubmit={submitEdit}>
      <div className="forum-write-title"><strong>{boardLabels[kind]} 글 수정</strong><span>수정 권한은 작성자와 관리자에게만 있습니다.</span></div>
      {isCommunityBoardCategory(kind) && <CommunityTagPicker value={editCommunityTags} onChange={setEditCommunityTags} />}
      <RichTitleInput value={editTitle} onChange={setEditTitle} autoFocus ariaLabel="게시글 제목" placeholder="제목을 입력해 주세요." />
      {(post.canPin || viewer?.level === 10) && (kind === "community" || kind === "reviews") && <label className="forum-pin-option"><input type="checkbox" checked={editPinned} onChange={(event) => setEditPinned(event.target.checked)} /> <span><b>상단 고정</b><small>체크하면 게시판 최상단에 고정됩니다.</small></span></label>}
      <RichTextEditor name="body" value={editBody} onChange={setEditBody} onBusyChange={setEditBusy} placeholder="내용을 입력해 주세요." />
      <div className="forum-write-actions"><button type="button" disabled={editBusy} onClick={() => { setEditTitle(post.title); setEditTitleColor((post.titleColor || "") as TitleColor); setEditBody(post.body); setEditPinned(Boolean(post.isPinned)); setEditCommunityTags(post.communityTags); setEditing(false); }}>취소</button><button type="submit" disabled={actionSubmitting || editBusy}>{editBusy ? "첨부 중…" : actionSubmitting ? "수정 중…" : "수정 완료"}</button></div>
    </form>
  </article>;
  return <article className="forum-detail">
    <header><h2><CommunityPostTitle category={kind} title={post.title} titleColor={post.titleColor} tags={post.communityTags} /></h2><div><span>{formatPostAuthor(post)}</span><span>{post.createdAt ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(post.createdAt)) : post.time}</span><span>조회 {post.views}</span><span>추천 {post.likes}</span><span>비추천 {post.dislikes}</span><span>신고 {post.reportCount}</span><span>댓글 {post.commentCount}</span></div></header>
    <PostRichBody body={post.body} poll={poll} viewer={viewer} postId={typeof post.id === "number" ? post.id : null} onLoginRequired={onLoginRequired} showToast={showToast} />
    <div className="forum-detail-actions">
      <div className="forum-vote-actions"><button type="button" disabled={actionSubmitting || post.isOwn || post.author === viewer?.nickname} onClick={() => void vote("up")} title={post.isOwn || post.author === viewer?.nickname ? "본인 글에는 투표할 수 없습니다." : undefined}><strong>추천</strong><span>{post.likes}</span></button><button type="button" disabled={actionSubmitting || post.isOwn || post.author === viewer?.nickname} onClick={() => void vote("down")} title={post.isOwn || post.author === viewer?.nickname ? "본인 글에는 투표할 수 없습니다." : undefined}><strong>비추천</strong><span>{post.dislikes}</span></button></div>
      <div className="forum-secondary-actions"><button type="button" onClick={() => { const url = post.live ? `${window.location.origin}${window.location.pathname}?board=${kind}&post=${post.id}` : window.location.href; void navigator.clipboard?.writeText(url).then(() => showToast("게시글 주소를 복사했습니다.")).catch(() => showToast("주소를 복사하지 못했습니다.")); }}>공유</button><button type="button" disabled={actionSubmitting} onClick={() => setReportOpen((current) => !current)}>신고</button>{post.canEdit && <button type="button" className="post-edit-button" disabled={actionSubmitting} onClick={() => setEditing(true)}>수정</button>}{post.canDelete && <button type="button" className="admin-delete-button" disabled={actionSubmitting} onClick={() => void deletePost()}>삭제</button>}</div>
    </div>
    {reportOpen && <div className="report-reasons" role="group" aria-label="신고 사유 선택"><b>신고 사유를 선택해 주세요.</b><div><button type="button" disabled={actionSubmitting} onClick={() => void report("무단 홍보")}>무단 홍보</button><button type="button" disabled={actionSubmitting} onClick={() => void report("사기")}>사기</button><button type="button" disabled={actionSubmitting} onClick={() => void report("도배")}>도배</button><button type="button" onClick={() => setReportOpen(false)}>취소</button></div><p>회원 한 명당 게시글 하나에 한 번만 신고할 수 있습니다.</p></div>}
    <section className="forum-comments">
      <div className="comment-heading"><b>전체 댓글 <em>{post.commentCount}</em>개</b><div><label><input type="radio" checked={sort === "old"} onChange={() => setSort("old")} /> 등록순</label><label><input type="radio" checked={sort === "new"} onChange={() => setSort("new")} /> 최신순</label></div></div>
      <div className="comment-list">{sortedComments.map((comment) => <div className="comment-item" key={comment.id}><b>{comment.authorLevel > 0 ? `Lv.${comment.authorLevel} ${comment.author}` : comment.author}</b><p>{comment.body}</p><time>{formatPostTime(comment.createdAt)}</time></div>)}{comments.length === 0 && <p className="comment-empty">첫 댓글을 남겨보세요.</p>}</div>
      <div className="comment-write"><div><strong>{viewer ? viewer.nickname : "로그인이 필요합니다"}</strong><span>{commentBody.length} / 500</span></div><textarea value={commentBody} onChange={(event) => setCommentBody(event.target.value)} maxLength={500} placeholder="댓글을 입력해 주세요." onFocus={() => { if (!viewer) onLoginRequired(); }} /><div><button type="button" disabled={submitting} onClick={() => void submitComment(false)}>등록</button><button type="button" disabled={submitting || post.isOwn || post.author === viewer?.nickname} onClick={() => void submitComment(true)}>등록+추천</button></div></div>
    </section>
  </article>;
}

function PostRichBody({ body, poll, viewer, postId, onLoginRequired, showToast }: { body: string; poll: PostPoll | null; viewer: Viewer | null; postId: number | null; onLoginRequired: () => void; showToast: (message: string) => void }) {
  const html = renderRichBody(body);
  const parts = html.split(/(<div class="post-poll-slot" data-poll-id="\d+"><\/div>)/i);
  return <div className="forum-detail-body rich-body">{parts.map((part, index) => /^<div class="post-poll-slot"/i.test(part)
    ? poll && postId ? <PostPollCard key={`poll-${poll.id}`} initialPoll={poll} viewer={viewer} postId={postId} onLoginRequired={onLoginRequired} showToast={showToast} /> : <div className="post-poll-loading" key={`poll-loading-${index}`}>투표 정보를 불러오는 중입니다.</div>
    : part ? <div className="rich-body-fragment" key={`body-${index}`} dangerouslySetInnerHTML={{ __html: part }} /> : null)}</div>;
}

function PostPollCard({ initialPoll, viewer, postId, onLoginRequired, showToast }: { initialPoll: PostPoll; viewer: Viewer | null; postId: number; onLoginRequired: () => void; showToast: (message: string) => void }) {
  const [poll, setPoll] = useState(initialPoll);
  const [submitting, setSubmitting] = useState(false);
  const showResults = poll.selectedOptionId !== null;

  const submitVote = async (optionId: number) => {
    if (!viewer) { onLoginRequired(); showToast("로그인 후 투표할 수 있습니다."); return; }
    if (showResults || submitting) return;
    setSubmitting(true);
    try {
      const response = await fetch(`/api/posts/${postId}/poll`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ optionId }) });
      const result = await response.json() as { poll?: PostPoll; error?: string };
      if (!response.ok || !result.poll) throw new Error(result.error ?? "투표를 처리하지 못했습니다.");
      setPoll(result.poll);
      showToast("투표가 완료되었습니다. 결과를 확인해 주세요.");
    } catch (error) { showToast(error instanceof Error ? error.message : "투표를 처리하지 못했습니다."); }
    finally { setSubmitting(false); }
  };

  return <section className={`post-poll-card ${showResults ? "show-results" : ""}`} aria-label={`투표: ${poll.question}`}>
    <header><div><span>VOTE</span><h3>{poll.question}</h3></div><em>{showResults ? "투표 완료" : "진행 중"}</em></header>
    <div className="post-poll-options">{poll.options.map((option) => <button type="button" className={poll.selectedOptionId === option.id ? "selected" : ""} disabled={submitting || showResults} onClick={() => void submitVote(option.id)} key={option.id}>
      {showResults && <i style={{ width: `${option.percentage}%` }} />}
      <span className="post-poll-check">{poll.selectedOptionId === option.id ? "✓" : ""}</span><b>{option.label}</b>{showResults && <strong>{option.percentage}% <small>{option.votes.toLocaleString()}표</small></strong>}
    </button>)}</div>
    <footer><span>{showResults ? `총 ${poll.totalVotes.toLocaleString()}명 참여` : `${poll.options.length}개 선택지 중 하나를 선택해 주세요.`}</span><b>계정당 1회 참여</b></footer>
  </section>;
}

function Modal({ type, onClose, onSubmit, onSwitch, submitting }: { type: "login" | "signup"; onClose: () => void; onSubmit: (event: FormEvent<HTMLFormElement>) => void; onSwitch: (type: "login" | "signup") => void; submitting: boolean }) {
  const [captchaKey, setCaptchaKey] = useState(() => Date.now());
  return <div className="modal-backdrop" onMouseDown={onClose}>
    <form key={type} className={`modal account-modal ${type === "signup" ? "signup-modal" : ""}`} onSubmit={onSubmit} onMouseDown={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="account-modal-title">
      <button type="button" className="modal-close" onClick={onClose} aria-label="창 닫기">×</button>
      <img src="/logo.png" alt="출장나라" />
      <h2 id="account-modal-title">{type === "signup" ? "빠른 회원가입" : "다시 오신 것을 환영해요"}</h2>
      <p className="modal-lead">{type === "signup" ? "필요한 정보만 간단하게 입력하세요." : "아이디와 비밀번호를 입력하세요."}</p>
      {type === "signup" ? <>
        <div className="signup-grid">
          <label>아이디<input name="username" required minLength={4} maxLength={20} autoComplete="username" placeholder="영문·숫자 4자 이상" /></label>
          <label>닉네임<input name="nickname" required minLength={2} maxLength={12} autoComplete="nickname" placeholder="2–12자" /></label>
          <label>비밀번호<input name="password" required type="password" minLength={8} autoComplete="new-password" placeholder="8자 이상" /></label>
          <label>비밀번호 확인<input name="passwordConfirm" required type="password" minLength={8} autoComplete="new-password" placeholder="비밀번호를 한 번 더 입력하세요" /></label>
        </div>
        <p className="security-note">비밀번호는 보안을 위해 단방향 암호화되어 원문 확인 및 기존 비밀번호 복구가 불가능합니다.<br />분실 시 새로 가입해 주셔야 하므로 비밀번호를 잊지 않도록 주의해 주세요.</p>
        <div className="captcha-field">
          <div className="captcha-heading"><b>자동 등록 방지</b><span aria-hidden="true">필수</span></div>
          <div className="captcha-row">
            <img key={captchaKey} src={`/api/captcha?t=${captchaKey}`} alt="자동 등록 방지 숫자 이미지" />
            <button type="button" className="captcha-refresh" onClick={() => setCaptchaKey(Date.now())} aria-label="자동 등록 방지 숫자 새로고침"><span aria-hidden="true">↻</span><small>새로고침</small></button>
            <label className="captcha-answer" htmlFor="captcha-answer"><span className="sr-only">자동 등록 방지 숫자</span><input id="captcha-answer" name="captchaAnswer" required inputMode="numeric" pattern="[0-9]{5}" minLength={5} maxLength={5} autoComplete="off" placeholder="숫자 5자리" /></label>
          </div>
          <p>이미지의 숫자를 순서대로 입력해 주세요.</p>
        </div>
      </> : <>
        <label>아이디<input name="username" required minLength={4} maxLength={20} autoComplete="username" placeholder="영문·숫자 4자 이상" /></label>
        <label>비밀번호<input name="password" required type="password" minLength={8} autoComplete="current-password" placeholder="8자 이상" /></label>
      </>}
      <button className="submit-button" type="submit" disabled={submitting}>{submitting ? "처리 중…" : type === "signup" ? "가입하기" : "로그인"}</button>
      <button className="switch-link" type="button" onClick={() => onSwitch(type === "signup" ? "login" : "signup")}>{type === "signup" ? "이미 계정이 있어요" : "아직 계정이 없어요"}</button>
    </form>
  </div>;
}
