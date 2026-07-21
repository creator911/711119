import { env } from "cloudflare:workers";
import { loadEventLeaderboard, type EventPeriodType } from "../../../lib/event-leaderboard";

const validPeriod = (value: string | null): EventPeriodType => value === "monthly" ? "monthly" : "weekly";

export async function GET(request: Request) {
  try {
    const period = validPeriod(new URL(request.url).searchParams.get("period"));
    return Response.json(await loadEventLeaderboard(env.DB, period));
  } catch (error) {
    console.error("Event leaderboard load failed", error);
    return Response.json({ error: "이벤트 랭킹을 불러오지 못했습니다." }, { status: 500 });
  }
}
