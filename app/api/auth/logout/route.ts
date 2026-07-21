import { env } from "cloudflare:workers";

const tokenOf = (request: Request) => request.headers.get("cookie")?.match(/(?:^|; )cn_session=([^;]+)/)?.[1];

export async function POST(request: Request) {
  const token = tokenOf(request);
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return Response.json({ ok: true }, { headers: { "Set-Cookie": `cn_session=; Path=/; HttpOnly${secure}; SameSite=Lax; Max-Age=0` } });
}
