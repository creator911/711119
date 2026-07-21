import { env } from "cloudflare:workers";

type MediaObject = { body: ReadableStream<Uint8Array>; httpMetadata?: { contentType?: string }; etag: string };
type MediaBucket = { get: (key: string) => Promise<MediaObject | null> };

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  const productId = Number((await context.params).id);
  if (!Number.isInteger(productId) || productId < 1) return new Response("Not found", { status: 404 });
  const row = await env.DB.prepare("SELECT cover_key AS coverKey,version FROM shop_products WHERE id=? AND status='active'")
    .bind(productId).first<{ coverKey: string | null; version: number }>();
  if (!row?.coverKey || !/^shop-product\/[0-9a-f-]{36}\.(?:jpg|png|gif|webp)$/i.test(row.coverKey)) return new Response("Not found", { status: 404 });
  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return new Response("Storage unavailable", { status: 503 });
  const object = await bucket.get(row.coverKey);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, { headers: {
    "Content-Type": object.httpMetadata?.contentType ?? "image/jpeg",
    "Cache-Control": "public, max-age=3600",
    "ETag": object.etag,
    "X-Content-Type-Options": "nosniff",
  } });
}
