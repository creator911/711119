import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { loadSystemHealth } from "../../../lib/system-health";

const PRIVATE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  try {
    const operator = await adminSession(request, env);
    if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401, headers: PRIVATE_HEADERS });
    const driver = String(env.NARA_DATABASE_DRIVER ?? "sqlite").toLowerCase() === "postgres" ? "postgres" : "sqlite";
    const health = await loadSystemHealth(env.DB, {
      driver,
      cache: env.CACHE,
      media: env.MEDIA,
      requireDistributed: driver === "postgres",
    });
    return Response.json({ health }, {
      status: health.status === "unavailable" ? 503 : 200,
      headers: PRIVATE_HEADERS,
    });
  } catch (error) {
    console.error("Admin health check failed", error);
    return Response.json({
      health: {
        status: "unavailable",
        database: "error",
        cache: env.CACHE ? "error" : "not_configured",
        storage: env.MEDIA ? "error" : "not_configured",
        worker: env.CACHE ? "error" : "not_configured",
        migrations: "unknown",
        application: "not_ready",
        missingSchemaObjects: null,
        latencyMs: null,
        checkedAt: new Date().toISOString(),
      },
    }, { status: 503, headers: PRIVATE_HEADERS });
  }
}
