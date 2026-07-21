import { env } from "cloudflare:workers";

type MediaHead = { size: number; etag: string; httpMetadata?: { contentType?: string } };
type MediaObject = MediaHead & { body: ReadableStream<Uint8Array> };
type MediaBucket = {
  head: (key: string) => Promise<MediaHead | null>;
  get: (key: string, options?: { range: { offset: number; length: number } }) => Promise<MediaObject | null>;
};

const keyOf = (context: { params: Promise<{ key: string }> }) => context.params.then(({ key }) => key);

export async function GET(request: Request, context: { params: Promise<{ key: string }> }) {
  const key = await keyOf(context);
  if (!/^[0-9a-f-]{36}\.(?:jpg|png|gif|webp|avif|bmp|mp4|webm|ogv|mov)$/i.test(key)) return new Response("Not found", { status: 404 });
  const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
  if (!bucket) return new Response("Storage unavailable", { status: 503 });
  const head = await bucket.head(key);
  if (!head) return new Response("Not found", { status: 404 });
  const headers = new Headers({
    "Content-Type": head.httpMetadata?.contentType ?? "application/octet-stream",
    "Cache-Control": "public, max-age=31536000, immutable",
    "Accept-Ranges": "bytes",
    "ETag": head.etag,
    "X-Content-Type-Options": "nosniff",
  });
  const rangeHeader = request.headers.get("range");
  const match = rangeHeader?.match(/^bytes=(\d+)-(\d*)$/);
  if (match) {
    const start = Number(match[1]);
    const requestedEnd = match[2] ? Number(match[2]) : head.size - 1;
    const end = Math.min(requestedEnd, head.size - 1);
    if (!Number.isInteger(start) || start < 0 || start > end) {
      headers.set("Content-Range", `bytes */${head.size}`);
      return new Response(null, { status: 416, headers });
    }
    const object = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!object) return new Response("Not found", { status: 404 });
    headers.set("Content-Length", String(end - start + 1));
    headers.set("Content-Range", `bytes ${start}-${end}/${head.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  const object = await bucket.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  headers.set("Content-Length", String(head.size));
  return new Response(object.body, { headers });
}
