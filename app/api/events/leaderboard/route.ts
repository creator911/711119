import { env } from "cloudflare:workers";
import {
  loadEventLeaderboard,
  settleEventLeaderboard,
  type EventPeriodType,
} from "../../../lib/event-leaderboard";

const validPeriod = (value: string | null): EventPeriodType => value === "monthly" ? "monthly" : "weekly";

export async function GET(request: Request) {
  try {
    const period = validPeriod(new URL(request.url).searchParams.get("period"));
    // The legacy single-process SQLite deployment has no independent worker,
    // so it retains the existing request-triggered settlement behavior.
    // Split PostgreSQL deployments set APP_SURFACE=public and settle only in
    // the dedicated worker process and connection pool.
    if (String(env.APP_SURFACE ?? "all") === "all") {
      await settleEventLeaderboard(env.DB, period);
    }
    return Response.json(await loadEventLeaderboard(env.DB, period), {
      headers: {
        "Cache-Control": "public, max-age=15, s-maxage=30, stale-while-revalidate=60",
      },
    });
  } catch (error) {
    console.error("Event leaderboard load failed", error);
    return Response.json({ error: "이벤트 랭킹을 불러오지 못했습니다." }, { status: 500 });
  }
}
