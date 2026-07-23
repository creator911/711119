"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type PeriodType = "weekly" | "monthly";
type BoardType = "posts" | "comments";
type Period = { startDate: string; endDate: string };
type RewardRow = {
  boardType: BoardType;
  rank: number;
  userId: number | null;
  nickname: string | null;
  level: number | null;
  activityCount: number;
  points: number;
  paidAt: string | null;
};
type RewardAudit = {
  periodType: PeriodType;
  previous: { period: Period; rows: RewardRow[] };
  current: { period: Period; rows: RewardRow[] };
};

const boardLabel = (type: BoardType) => type === "posts" ? "글쓰기왕" : "댓글왕";
const activityLabel = (type: BoardType) => type === "posts" ? "작성글" : "댓글수";
const periodLabel = (period: Period) => `${period.startDate.replaceAll("-", ".")}–${period.endDate.replaceAll("-", ".")}`;

export default function AdminEventRewards() {
  const [period, setPeriod] = useState<PeriodType>("weekly");
  const [data, setData] = useState<RewardAudit | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const requestSequence = useRef(0);
  const activeRequest = useRef<AbortController | null>(null);

  const load = useCallback(async (selected: PeriodType) => {
    const requestId = ++requestSequence.current;
    activeRequest.current?.abort();
    const controller = new AbortController();
    activeRequest.current = controller;
    setLoading(true);
    setError("");
    try {
      const response = await fetch(`/api/admin/event-rewards?period=${selected}`, {
        cache: "no-store",
        signal: controller.signal,
      });
      const result = await response.json() as RewardAudit & { error?: string };
      if (!response.ok) throw new Error(result.error ?? "이벤트 보상 내역을 불러오지 못했습니다.");
      if (requestId !== requestSequence.current || result.periodType !== selected) return;
      setData(result);
    } catch (loadError) {
      if (controller.signal.aborted || requestId !== requestSequence.current) return;
      setError(loadError instanceof Error ? loadError.message : "이벤트 보상 내역을 불러오지 못했습니다.");
    } finally {
      if (requestId === requestSequence.current) {
        activeRequest.current = null;
        setLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(period), 0);
    return () => {
      window.clearTimeout(timer);
      activeRequest.current?.abort();
    };
  }, [load, period]);

  const changePeriod = (next: PeriodType) => {
    if (next === period) return;
    setData(null);
    setPeriod(next);
  };

  return <section className="admin-panel event-reward-audit" aria-labelledby="event-reward-audit-title">
    <div className="panel-title event-reward-audit-title">
      <div><h2 id="event-reward-audit-title">랭킹 보상 로그</h2><p>지난 지급 결과 6명과 현재 예상 수상자 6명을 확인합니다.</p></div>
      <div className="event-reward-audit-actions">
        <div className="event-reward-period-tabs" role="group" aria-label="집계 기간">
          <button type="button" className={period === "weekly" ? "active" : ""} onClick={() => changePeriod("weekly")}>주간</button>
          <button type="button" className={period === "monthly" ? "active" : ""} onClick={() => changePeriod("monthly")}>월간</button>
        </div>
        <button type="button" onClick={() => void load(period)} disabled={loading}>새로고침</button>
      </div>
    </div>
    {error && <p className="event-reward-error" role="alert">{error}</p>}
    <div className={`event-reward-periods ${loading ? "loading" : ""}`} aria-busy={loading}>
      <RewardPeriod title="지난 보상 지급" badge="지급 완료" period={data?.previous.period} rows={data?.previous.rows} emptyLabel="지급 내역 없음" />
      <RewardPeriod title="현재 예상 수상" badge="집계 중" period={data?.current.period} rows={data?.current.rows} emptyLabel="집계 인원 없음" current />
    </div>
  </section>;
}

function RewardPeriod({ title, badge, period, rows, emptyLabel, current = false }: { title: string; badge: string; period?: Period; rows?: RewardRow[]; emptyLabel: string; current?: boolean }) {
  return <article className="event-reward-period">
    <header><div><b>{title}</b><small>{period ? periodLabel(period) : "불러오는 중"}</small></div><em className={current ? "current" : "paid"}>{badge}</em></header>
    <div className="event-reward-columns" aria-hidden="true"><span>구분</span><span>순위</span><span>회원</span><span>활동</span><span>보상</span></div>
    {(["posts", "comments"] as const).map((boardType) => <section className="event-reward-board" key={boardType}>
      <h3>{boardLabel(boardType)}</h3>
      {[1, 2, 3].map((rank) => {
        const row = rows?.find((candidate) => candidate.boardType === boardType && candidate.rank === rank);
        const populated = Boolean(row?.userId);
        return <div className={`event-reward-row rank-${rank} ${populated ? "" : "empty"}`} key={rank}>
          <strong>{rank}</strong>
          <span>{populated ? <><i>Lv.{row?.level ?? 1}</i><b>{row?.nickname}</b></> : <small>{emptyLabel}</small>}</span>
          <span>{populated ? `${activityLabel(boardType)} ${row?.activityCount.toLocaleString()}` : "-"}</span>
          <em>{populated && row?.points ? `${row.points.toLocaleString()}P` : "-"}</em>
        </div>;
      })}
    </section>)}
  </article>;
}
