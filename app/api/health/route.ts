import { env } from "cloudflare:workers";

export async function GET() {
  const startedAt = performance.now();
  try {
    const ping = await env.DB.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (Number(ping?.ok) !== 1) throw new Error("database unavailable");
    return Response.json({
      status: "ok",
      surface: String(env.APP_SURFACE ?? "all"),
      latencyMs: Math.round((performance.now() - startedAt) * 10) / 10,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({
      status: "unavailable",
      surface: String(env.APP_SURFACE ?? "all"),
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
