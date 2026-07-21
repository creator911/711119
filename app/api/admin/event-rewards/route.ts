import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { loadAdminEventRewardAudit, type EventPeriodType } from "../../../lib/event-leaderboard";

const periodType = (value: string | null): EventPeriodType => value === "monthly" ? "monthly" : "weekly";

export async function GET(request: Request) {
  if (!await adminSession(request, env)) {
    return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  }

  try {
    const period = periodType(new URL(request.url).searchParams.get("period"));
    return Response.json(await loadAdminEventRewardAudit(env.DB, period));
  } catch (error) {
    console.error("Load admin event reward audit failed", error);
    return Response.json({ error: "이벤트 보상 내역을 불러오지 못했습니다." }, { status: 500 });
  }
}
