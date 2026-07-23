"use client";

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ATTENDANCE_STREAK_REWARDS } from "../lib/attendance-rewards";
import { attendancePointsForLevel } from "../lib/member-level";

const attendanceGreetings = [
  "역시 하루의 시작은 출장나라", "오늘도 출장나라와 함께 출발", "기분 좋은 하루 보내세요", "오늘도 모두 좋은 일만 가득", "출장나라 출석하고 하루 시작",
  "매일매일 잊지 않고 출석", "오늘도 반갑습니다", "좋은 아침 행복한 하루", "오늘 하루도 파이팅", "즐거운 하루 보내세요",
  "출장나라와 함께하는 아침", "오늘도 웃음 가득한 하루", "꾸준함이 최고의 힘입니다", "출석 완료 모두 행복하세요", "오늘도 좋은 정보 함께 나눠요",
  "하루 한 번 반가운 출석", "매일 찾아오는 출장나라", "오늘도 안전하고 편안하게", "행운이 가득한 하루 되세요", "모두 건강한 하루 보내세요",
  "출석으로 시작하는 좋은 습관", "반가운 마음으로 출석합니다", "오늘도 기분 좋게 출석", "출장나라 가족들 모두 파이팅", "미소와 행복이 가득한 하루",
  "오늘도 함께해서 든든합니다", "좋은 하루의 첫 도장", "잊지 않고 오늘도 출석", "오늘도 산뜻한 하루 보내세요", "출장나라에서 오늘도 만나요",
  "매일 출석 목표 달성 중", "힘찬 하루를 응원합니다", "오늘도 좋은 선택 출장나라", "반갑습니다 오늘도 출석", "행복한 하루의 시작입니다",
  "출석 도장 꾹 찍고 갑니다", "오늘도 모두 좋은 하루", "꾸준함 모으는 출석 포인트", "출장나라와 즐거운 하루", "오늘 하루도 잘 부탁드려요",
  "매일 찾아와 인사드립니다", "좋은 인연 좋은 하루", "오늘도 출석 미션 완료", "따뜻한 하루 보내세요", "활기찬 아침 함께 시작해요",
  "오늘도 감사한 마음으로 출석", "반가운 출장나라 좋은 아침", "매일의 작은 성공 출석 완료", "즐거운 소식 가득한 하루", "내일도 잊지 않고 만나요",
];

type AttendanceEntry = { id: number; createdAt: string; greeting: string; points: number; nickname: string; totalDays: number };
type StreakReward = { days: number; points: number; earned: boolean; reachable?: boolean };
type AttendanceData = {
  today: string;
  month: string;
  calendar: Array<{ date: string; points: number }>;
  entries: AttendanceEntry[];
  entriesTotal: number;
  nextEntriesCursor: null | { createdAt: string; id: number };
  streakRewards: StreakReward[];
  user: null | { nickname: string; points: number; level: number; attendancePoints: number; attended: boolean; totalDays: number; currentStreak: number; bestStreak: number };
};

const randomGreeting = () => attendanceGreetings[Math.floor(Math.random() * attendanceGreetings.length)];
const pad = (value: number) => String(value).padStart(2, "0");
const weekdays = ["일요일", "월요일", "화요일", "수요일", "목요일", "금요일", "토요일"];
const fallbackRewards = ATTENDANCE_STREAK_REWARDS.map((reward) => ({ ...reward, earned: false }));

export default function AttendanceModal({ onClose, onLoginRequired, onAttendance, showToast }: {
  onClose: () => void;
  onLoginRequired: () => void;
  onAttendance: (points: number, level?: number) => void;
  showToast: (message: string) => void;
}) {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [monthIndex, setMonthIndex] = useState(now.getMonth());
  const [data, setData] = useState<AttendanceData | null>(null);
  const [greeting, setGreeting] = useState(randomGreeting);
  const [rewardsOpen, setRewardsOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const attendanceRequestSequenceRef = useRef(0);
  const monthKey = `${year}-${pad(monthIndex + 1)}`;
  const attendancePointAmount = data?.user?.attendancePoints ?? attendancePointsForLevel(data?.user?.level ?? 1);

  const loadAttendance = useCallback(async () => {
    const sequence = ++attendanceRequestSequenceRef.current;
    setLoading(true);
    try {
      const response = await fetch(`/api/attendance?month=${monthKey}`, { cache: "no-store" });
      const result = await response.json() as AttendanceData & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "출석 정보를 불러오지 못했습니다.");
      if (sequence === attendanceRequestSequenceRef.current) setData(result);
    } catch (error) {
      if (sequence === attendanceRequestSequenceRef.current) {
        showToast(error instanceof Error ? error.message : "출석 정보를 불러오지 못했습니다.");
      }
    } finally {
      if (sequence === attendanceRequestSequenceRef.current) setLoading(false);
    }
  }, [monthKey, showToast]);

  const loadMoreEntries = async () => {
    const cursor = data?.nextEntriesCursor;
    if (!cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const search = new URLSearchParams({ month: monthKey, afterCreatedAt: cursor.createdAt, afterId: String(cursor.id) });
      const response = await fetch(`/api/attendance?${search.toString()}`, { cache: "no-store" });
      const result = await response.json() as AttendanceData & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "출석 인사를 더 불러오지 못했습니다.");
      if (data?.today && data.today !== result.today) {
        const [nextYear, nextMonth] = result.today.split("-").map(Number);
        setYear(nextYear);
        setMonthIndex(nextMonth - 1);
        setData(null);
        return;
      }
      setData((current) => current && current.today === result.today ? {
        ...current,
        entries: [...current.entries, ...result.entries.filter((entry) => !current.entries.some((item) => item.id === entry.id))],
        entriesTotal: result.entriesTotal,
        nextEntriesCursor: result.nextEntriesCursor,
      } : current);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "출석 인사를 더 불러오지 못했습니다.");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    const timer = window.setTimeout(() => void loadAttendance(), 0);
    return () => window.clearTimeout(timer);
  }, [loadAttendance]);

  useEffect(() => {
    if (!rewardsOpen) return;
    const closeRewards = (event: KeyboardEvent) => {
      if (event.key === "Escape") setRewardsOpen(false);
    };
    window.addEventListener("keydown", closeRewards);
    return () => window.removeEventListener("keydown", closeRewards);
  }, [rewardsOpen]);

  const calendarPoints = useMemo(() => new Map(data?.calendar.map((item) => [item.date, item.points]) ?? []), [data]);
  const calendarCells = useMemo(() => {
    const firstWeekday = new Date(year, monthIndex, 1).getDay();
    const days = new Date(year, monthIndex + 1, 0).getDate();
    const cells: Array<number | null> = [...Array(firstWeekday).fill(null), ...Array.from({ length: days }, (_, index) => index + 1)];
    while (cells.length % 7) cells.push(null);
    return cells;
  }, [monthIndex, year]);

  const moveMonth = (amount: number) => {
    const next = new Date(year, monthIndex + amount, 1);
    setYear(next.getFullYear());
    setMonthIndex(next.getMonth());
  };

  const moveToCurrentMonth = () => {
    const current = new Date();
    setYear(current.getFullYear());
    setMonthIndex(current.getMonth());
  };

  const submitAttendance = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submitting || data?.user?.attended) return;
    setSubmitting(true);
    try {
      const response = await fetch("/api/attendance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ greeting }),
      });
      const result = await response.json() as { error?: string; points?: number; level?: number; attendancePoints?: number; rewardBonusPoints?: number };
      if (response.status === 401) {
        showToast("로그인 후 출석할 수 있어요.");
        onLoginRequired();
        return;
      }
      if (!response.ok) throw new Error(result.error ?? "출석 처리 중 오류가 발생했습니다.");
      const awardedPoints = result.attendancePoints ?? attendancePointAmount;
      onAttendance(result.points ?? awardedPoints, result.level);
      setGreeting(randomGreeting());
      showToast(result.rewardBonusPoints ? `출석 완료! ${awardedPoints.toLocaleString()}P + 개근보상 ${result.rewardBonusPoints.toLocaleString()}P가 적립됐어요.` : `출석 완료! ${awardedPoints.toLocaleString()}P가 적립됐어요.`);
      await loadAttendance();
    } catch (error) {
      showToast(error instanceof Error ? error.message : "출석 처리 중 오류가 발생했습니다.");
    } finally {
      setSubmitting(false);
    }
  };

  const formatTime = (value: string) => value
    ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: true }).format(new Date(value))
    : "-";

  return <div className="modal-backdrop attendance-backdrop" onMouseDown={onClose}>
    <section className="attendance-modal" role="dialog" aria-modal="true" aria-labelledby="attendance-title" onMouseDown={(event) => event.stopPropagation()}>
      <button type="button" className="modal-close" onClick={onClose} aria-label="출석체크 닫기">×</button>
      <header className="attendance-header">
        <div><p className="eyebrow">DAILY CHECK-IN</p><h2 id="attendance-title">출장나라 출석체크</h2></div>
        <p>매일 한 번 출석하고 <b>{attendancePointAmount.toLocaleString()}P</b>를 받아가세요.</p>
      </header>

      <div className="calendar-toolbar">
        <strong>{year}</strong>
        <h3>{monthIndex + 1}월</h3>
        <div><button type="button" onClick={() => moveMonth(-1)}>« 이전 달</button><button type="button" onClick={moveToCurrentMonth}>이번 달</button><button type="button" onClick={() => moveMonth(1)}>다음 달 »</button></div>
      </div>

      <div className="attendance-calendar-stage">
        <div className="attendance-calendar" aria-label={`${year}년 ${monthIndex + 1}월 출석 달력`} aria-hidden={rewardsOpen ? true : undefined}>
          {weekdays.map((weekday) => <div className="calendar-weekday" key={weekday}>{weekday}</div>)}
          {calendarCells.map((day, index) => {
            const date = day ? `${year}-${pad(monthIndex + 1)}-${pad(day)}` : "";
            const awardedPoints = date ? calendarPoints.get(date) ?? 0 : 0;
            const isToday = date === data?.today;
            return <div className={`calendar-day ${day ? "" : "empty"} ${isToday ? "today" : ""}`} key={`${index}-${day ?? "empty"}`}>
              {day && <><span>{day}</span>{awardedPoints > 0 && <b>{awardedPoints.toLocaleString()}P</b>}{isToday && <small>오늘</small>}</>}
            </div>;
          })}
        </div>
        {rewardsOpen && <section id="streak-reward-panel" className="streak-reward-overlay" role="region" aria-labelledby="streak-reward-title">
          <header className="streak-reward-overlay-head">
            <div><p>ATTENDANCE REWARDS</p><h3 id="streak-reward-title">개근보상</h3><span>연속 출석 달성 시 포인트가 자동 지급됩니다.</span></div>
            <button type="button" autoFocus onClick={() => setRewardsOpen(false)} aria-label="개근보상 닫기">×</button>
          </header>
          <StreakRewardList rewards={data?.streakRewards ?? fallbackRewards} currentStreak={data?.user?.currentStreak ?? 0} />
        </section>}
      </div>

      <div className="attendance-stats">
        <div><b>출석 가능시간: 00시 00분 00초 ~ 23시 59분 59초</b><p>나의 총 출석일: <strong>{data?.user?.totalDays ?? 0}일</strong><span>나의 개근일: <strong>{data?.user?.currentStreak ?? 0}일째</strong></span><span>역대 최고 개근일: <strong>{data?.user?.bestStreak ?? 0}일</strong></span></p></div>
        <div className="attendance-tabs"><button type="button" className={rewardsOpen ? "active" : ""} aria-expanded={rewardsOpen} aria-controls="streak-reward-panel" onClick={() => setRewardsOpen(true)}>🏆 개근보상</button><button type="button" className={!rewardsOpen ? "active" : ""} onClick={() => setRewardsOpen(false)}>🪙 매일 {attendancePointAmount.toLocaleString()}P 적립</button></div>
      </div>

      {data?.user?.attended ? <div className="attendance-complete"><span>출석<br />체크</span><div><h3>오늘 출석체크 완료! 내일도 잊지 마세요!</h3><p>출석체크는 하루 1회, 00시 00분에 갱신됩니다.</p></div></div> : <form className="attendance-form" onSubmit={submitAttendance}><input value={greeting} onChange={(event) => setGreeting(event.target.value)} maxLength={50} aria-label="출석 인사" placeholder="역시 하루의 시작은 출장나라" /><button type="submit" disabled={submitting}>{submitting ? "처리 중…" : "출석체크 도장찍기"}<span aria-hidden="true">출석</span></button></form>}

      <div className="attendance-board">
        <div className="attendance-board-title"><h3>오늘의 출석 인사</h3><span>{loading ? "불러오는 중…" : `${data?.entriesTotal ?? data?.entries.length ?? 0}명이 출석했어요`}</span></div>
        <div className="attendance-table"><div className="attendance-tr head"><span>순서</span><span>출석시간</span><span>닉네임</span><span>출석인사</span><span>적립포인트</span><span>누적출석</span></div>{data?.entries.length ? data.entries.map((entry, index) => <div className="attendance-tr" key={entry.id}><span>{index + 1}</span><span>{formatTime(entry.createdAt)}</span><b>{entry.nickname}</b><span>{entry.greeting}</span><strong>{entry.points.toLocaleString()}P</strong><span>{entry.totalDays}일</span></div>) : <p className="attendance-empty">오늘 첫 번째 출석 인사를 남겨보세요.</p>}</div>
        {data?.nextEntriesCursor && <button type="button" className="attendance-more" onClick={() => void loadMoreEntries()} disabled={loadingMore}>{loadingMore ? "불러오는 중…" : "출석 인사 더보기"}</button>}
      </div>
    </section>
  </div>;
}

function StreakRewardList({ rewards, currentStreak }: { rewards: StreakReward[]; currentStreak: number }) {
  return <div className="streak-reward-list">
    {rewards.map((reward) => {
      const progress = Math.min(100, Math.floor((currentStreak / reward.days) * 100));
      return <div className={reward.earned ? "earned" : ""} key={reward.days}>
        <span>{reward.days}일</span>
        <b>개근 {reward.days}일</b>
        <strong>{reward.points.toLocaleString()}P</strong>
        <small>{reward.earned ? "지급완료" : currentStreak >= reward.days ? "달성 가능" : `${Math.max(0, reward.days - currentStreak)}일 남음`}</small>
        <i><em style={{ width: `${progress}%` }} /></i>
      </div>;
    })}
  </div>;
}
