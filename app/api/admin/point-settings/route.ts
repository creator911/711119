import { env } from "cloudflare:workers";
import { adminSession } from "../../../lib/admin-auth";
import { loadPointSettings, savePointSettings } from "../../../lib/point-settings";

export async function GET(request: Request) {
  if (!await adminSession(request, env)) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    return Response.json({ settings: await loadPointSettings(env.DB) });
  } catch (error) {
    console.error("Load point settings failed", error);
    return Response.json({ error: "포인트 지급 설정을 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PUT(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });
  try {
    const payload = await request.json();
    return Response.json({ ok: true, settings: await savePointSettings(env.DB, payload, operator.username) });
  } catch (error) {
    console.error("Save point settings failed", error);
    return Response.json({ error: "포인트 지급 설정을 저장하지 못했습니다." }, { status: 500 });
  }
}
