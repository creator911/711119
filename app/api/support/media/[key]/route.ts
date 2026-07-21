import { env } from "cloudflare:workers";
import { adminSession } from "../../../../lib/admin-auth";
import { memberFromSession } from "../../../../lib/member-auth";
import { serveMediaObject } from "../../../media/[key]/route";

const keyOf = (context: { params: Promise<{ key: string }> }) => context.params.then(({ key }) => key.toLowerCase());

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const key = await keyOf(context);
  if (!/^[0-9a-f-]{36}\.(?:jpg|png|gif|webp|avif|bmp)$/i.test(key)) return new Response("Not found", { status: 404 });

  let member = null;
  try { member = await memberFromSession(request); } catch { /* 관리자 세션 확인을 계속합니다. */ }
  const operator = await adminSession(request, env);
  if (!member && !operator) return new Response("Not found", { status: 404 });

  const memberAuthorized = member ? await env.DB.prepare(`
        SELECT 1 FROM uploaded_media_references r
        JOIN support_inquiries i ON CAST(i.id AS TEXT)=r.resource_id
        WHERE r.media_key=? AND r.resource_type='support' AND i.user_id=? AND i.status!='deleted'
        LIMIT 1
      `).bind(key, member.id).first() : null;
  const authorized = memberAuthorized ?? (operator ? await env.DB.prepare(`
        SELECT 1 FROM uploaded_media_references r
        JOIN support_inquiries i ON CAST(i.id AS TEXT)=r.resource_id
        WHERE r.media_key=? AND r.resource_type='support' AND i.status!='deleted'
        LIMIT 1
      `).bind(key).first() : null);
  if (!authorized) return new Response("Not found", { status: 404 });

  const response = await serveMediaObject(request, key);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("Vary", "Cookie");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
