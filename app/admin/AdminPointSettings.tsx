"use client";

import { FormEvent, useEffect, useState } from "react";
import { DEFAULT_POINT_SETTINGS, type PointSystemSettings } from "../lib/point-settings";

const cloneSettings = (settings: PointSystemSettings): PointSystemSettings => JSON.parse(JSON.stringify(settings)) as PointSystemSettings;
const toNumber = (value: string) => Math.max(0, Math.trunc(Number(value) || 0));

export default function AdminPointSettings() {
  const [settings, setSettings] = useState<PointSystemSettings>(() => cloneSettings(DEFAULT_POINT_SETTINGS));
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setLoading(true);
      void fetch("/api/admin/point-settings", { cache: "no-store" })
        .then(async (response) => {
          const result = await response.json() as { settings?: PointSystemSettings; error?: string };
          if (!response.ok || !result.settings) throw new Error(result.error ?? "포인트 설정을 불러오지 못했습니다.");
          if (!cancelled) setSettings(result.settings);
        })
        .catch((error) => {
          if (!cancelled) setMessage(error instanceof Error ? error.message : "포인트 설정을 불러오지 못했습니다.");
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);

  const update = (changes: Partial<PointSystemSettings>) => setSettings((current) => ({ ...current, ...changes }));
  const updateLevel = (level: 2 | 3 | 4 | 5, field: "attendance" | "posts" | "comments", value: string) => {
    setSettings((current) => ({
      ...current,
      levelRequirements: current.levelRequirements.map((item) => item.level === level ? { ...item, [field]: toNumber(value) } : item),
    }));
  };
  const updateReward = (period: "weekly" | "monthly", board: "posts" | "comments", rankIndex: 0 | 1 | 2, value: string) => {
    setSettings((current) => {
      const next = cloneSettings(current);
      next.eventRewards[period][board][rankIndex] = toNumber(value);
      return next;
    });
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setMessage("");
    try {
      const response = await fetch("/api/admin/point-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result = await response.json() as { settings?: PointSystemSettings; error?: string };
      if (!response.ok || !result.settings) throw new Error(result.error ?? "포인트 설정을 저장하지 못했습니다.");
      setSettings(result.settings);
      setMessage("포인트 지급 설정을 저장했습니다.");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "포인트 설정을 저장하지 못했습니다.");
    } finally {
      setSaving(false);
    }
  };

  return <form className="admin-panel point-settings-panel" onSubmit={save}>
    <div className="panel-title">
      <div><h2>포인트 지급 시스템</h2><p>출석, 글·후기·댓글 작성, 레벨업 조건, 주간·월간 랭킹 보상을 한곳에서 조정합니다.</p></div>
      <button type="submit" disabled={loading || saving}>{saving ? "저장 중…" : "설정 저장"}</button>
    </div>

    {loading ? <p className="admin-empty">포인트 설정을 불러오는 중입니다.</p> : <div className="point-settings-grid">
      <fieldset>
        <legend>신규 활동 지급</legend>
        <label>신규 글 작성<input type="number" min="0" value={settings.postCreatePoints} onChange={(event) => update({ postCreatePoints: toNumber(event.target.value) })} /><span>P</span></label>
        <label>신규 후기 작성<input type="number" min="0" value={settings.reviewCreatePoints} onChange={(event) => update({ reviewCreatePoints: toNumber(event.target.value) })} /><span>P</span></label>
        <label>신규 댓글 작성<input type="number" min="0" value={settings.commentCreatePoints} onChange={(event) => update({ commentCreatePoints: toNumber(event.target.value) })} /><span>P</span></label>
      </fieldset>

      <fieldset>
        <legend>출석체크 보상</legend>
        <label>Lv.1 기본 지급<input type="number" min="0" value={settings.attendanceBasePoints} onChange={(event) => update({ attendanceBasePoints: toNumber(event.target.value) })} /><span>P</span></label>
        <label>레벨당 증가<input type="number" min="0" value={settings.attendanceLevelStepPoints} onChange={(event) => update({ attendanceLevelStepPoints: toNumber(event.target.value) })} /><span>P</span></label>
        <small>예: 기본 50P / 증가 10P이면 Lv.2는 60P, Lv.3은 70P로 지급됩니다.</small>
      </fieldset>

      <fieldset className="level-settings">
        <legend>자동 레벨업 조건</legend>
        <div className="level-settings-head"><span>레벨</span><span>출석일</span><span>글</span><span>댓글</span></div>
        {settings.levelRequirements.map((item) => <div className="level-settings-row" key={item.level}>
          <b>Lv.{item.level}</b>
          <input type="number" min="0" value={item.attendance} onChange={(event) => updateLevel(item.level, "attendance", event.target.value)} />
          <input type="number" min="0" value={item.posts} onChange={(event) => updateLevel(item.level, "posts", event.target.value)} />
          <input type="number" min="0" value={item.comments} onChange={(event) => updateLevel(item.level, "comments", event.target.value)} />
        </div>)}
        <small>Lv.6~9는 자동 승급하지 않고 운영진이 회원관리에서 직접 지정합니다.</small>
      </fieldset>

      <fieldset className="rank-settings">
        <legend>랭킹 보상</legend>
        {(["weekly", "monthly"] as const).map((period) => <section key={period}>
          <h3>{period === "weekly" ? "주간 랭킹" : "월간 랭킹"}</h3>
          {(["posts", "comments"] as const).map((board) => <div className="rank-settings-row" key={`${period}-${board}`}>
            <b>{board === "posts" ? "글쓰기왕" : "댓글왕"}</b>
            {[0, 1, 2].map((index) => <label key={index}>{index + 1}위<input type="number" min="0" value={settings.eventRewards[period][board][index]} onChange={(event) => updateReward(period, board, index as 0 | 1 | 2, event.target.value)} />P</label>)}
          </div>)}
        </section>)}
      </fieldset>
    </div>}
    {message && <p className="point-settings-message">{message}</p>}
  </form>;
}
