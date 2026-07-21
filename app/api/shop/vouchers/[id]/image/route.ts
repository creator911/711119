import { env } from "cloudflare:workers";
import { adminSession } from "../../../../../lib/admin-auth";
import { memberFromSession } from "../../../../../lib/member-auth";

type VoucherAccessRow = { objectKey: string; contentType: string; userId: number | null; status: string };
type MediaObject = { body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string } };
type MediaBucket = { get: (key: string) => Promise<MediaObject | null> };

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const voucherId = Number((await context.params).id);
  if (!Number.isInteger(voucherId) || voucherId < 1) return new Response("Not found", { status: 404 });
  const [member, operator] = await Promise.all([
    memberFromSession(request).catch(() => null),
    adminSession(request, env).catch(() => null),
  ]);
  if (!member && !operator) return new Response("Not found", { status: 404 });

  const voucher = await env.DB.prepare(`
    SELECT v.object_key AS objectKey,v.content_type AS contentType,v.status,
           p.user_id AS userId
    FROM shop_vouchers v LEFT JOIN shop_purchases p
      ON p.id=v.purchase_id
      AND p.voucher_id=v.id
      AND p.product_id=v.product_id
      AND p.status='delivered'
    WHERE v.id=?
  `).bind(voucherId).first<VoucherAccessRow>();
  if (!voucher || (!operator && (voucher.status !== "delivered" || voucher.userId !== member?.id))) {
    return new Response("Not found", { status: 404 });
  }
  if (!/^shop-private\/[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/i.test(voucher.objectKey)) return new Response("Not found", { status: 404 });
  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return new Response("Storage unavailable", { status: 503 });
  const object = await bucket.get(voucher.objectKey);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": object.httpMetadata?.contentType ?? voucher.contentType,
    "Cache-Control": "private, no-store, max-age=0",
    "Pragma": "no-cache",
    "X-Content-Type-Options": "nosniff",
  } });
}
