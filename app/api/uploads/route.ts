import { env } from "cloudflare:workers";
import { adminSession } from "../../lib/admin-auth";
import { memberFromSession } from "../../lib/member-auth";
import {
  adminMediaActorKey,
  discardPendingMedia,
  memberMediaActorKey,
  prunePendingMedia,
  recordPendingMedia,
} from "../../lib/media-lifecycle";
import {
  ADMIN_UPLOAD_LIMITS,
  MEMBER_UPLOAD_LIMITS,
  pruneUploadQuota,
  releaseUploadQuota,
  reserveUploadQuota,
} from "../../lib/upload-quota";
import { uploadConcurrencyGate } from "../../lib/upload-concurrency";
import {
  consumeDistributedRateLimit,
  distributedRateLimitResponse,
} from "../../lib/distributed-rate-limit";

type MediaBucket = {
  put: (key: string, value: ReadableStream<Uint8Array>, options: {
    httpMetadata: { contentType: string };
    customMetadata: Record<string, string>;
  }) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
  head?: (key: string) => Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>;
  createPresignedPutUrl?: (key: string, options: { expiresIn: number; contentType: string }) => Promise<string>;
};

const IMAGE_LIMIT = 12 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
};
const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
};

function fileKind(contentType: string) {
  const imageExtension = IMAGE_TYPES[contentType];
  const videoExtension = VIDEO_TYPES[contentType];
  if (imageExtension) return { mediaType: "image", extension: imageExtension, limit: IMAGE_LIMIT };
  if (videoExtension) return { mediaType: "video", extension: videoExtension, limit: VIDEO_LIMIT };
  return null;
}

async function uploadIdentity(request: Request) {
  const preferAdmin = request.headers.get("x-upload-context") === "admin";
  const preferredOperator = preferAdmin ? await adminSession(request, env) : null;
  let member = null;
  if (!preferredOperator) {
    try {
      member = await memberFromSession(request);
    } catch {
      // Continue to the admin cookie check.
    }
  }
  const operator = preferredOperator ?? (member ? null : await adminSession(request, env));
  if (!member && !operator) return null;
  return {
    member,
    operator,
    actorKey: member ? memberMediaActorKey(member.id) : adminMediaActorKey(operator!.role, operator!.username),
    limits: member ? MEMBER_UPLOAD_LIMITS : ADMIN_UPLOAD_LIMITS,
  };
}

async function prepareDirectUpload(request: Request, bucket: MediaBucket) {
  const identity = await uploadIdentity(request);
  if (!identity) return Response.json({ error: "로그인 후 파일을 첨부할 수 있습니다." }, { status: 401 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "media-upload", identity.actorKey, 600, 3_600);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
  if (!bucket.createPresignedPutUrl || !bucket.head) return Response.json({ direct: false });
  const payload = await request.json() as {
    action?: string;
    name?: string;
    contentType?: string;
    size?: number;
    key?: string;
    reservation?: string;
  };

  if (payload.action === "complete") {
    const key = String(payload.key ?? "").toLowerCase();
    const pending = await env.DB.prepare(`
      SELECT key,media_type AS mediaType,content_type AS contentType,size_bytes AS sizeBytes
      FROM uploaded_media
      WHERE key=? AND owner_key=? AND status='pending'
    `).bind(key, identity.actorKey).first<{
      key: string;
      mediaType: string;
      contentType: string;
      sizeBytes: number;
    }>();
    if (!pending) return Response.json({ error: "업로드 확인 정보가 올바르지 않습니다." }, { status: 400 });
    const head = await bucket.head(key);
    if (!head || Number(head.size) !== Number(pending.sizeBytes)) {
      await discardPendingMedia(env.DB, bucket, key).catch(() => undefined);
      if (payload.reservation) await releaseUploadQuota(env.DB, String(payload.reservation)).catch(() => undefined);
      return Response.json({ error: "업로드된 파일 크기를 확인할 수 없습니다." }, { status: 400 });
    }
    return Response.json({
      url: `/api/media/${key}`,
      mediaType: pending.mediaType,
      name: String(payload.name ?? ""),
      size: Number(pending.sizeBytes),
    }, { status: 201 });
  }

  if (payload.action === "cancel") {
    const key = String(payload.key ?? "").toLowerCase();
    const owned = await env.DB.prepare(
      "SELECT key FROM uploaded_media WHERE key=? AND owner_key=? AND status='pending'",
    ).bind(key, identity.actorKey).first();
    if (owned) await discardPendingMedia(env.DB, bucket, key).catch(() => undefined);
    if (payload.reservation) await releaseUploadQuota(env.DB, String(payload.reservation)).catch(() => undefined);
    return Response.json({ ok: true });
  }

  if (payload.action !== "prepare") return Response.json({ error: "업로드 요청을 확인해 주세요." }, { status: 400 });
  const contentType = String(payload.contentType ?? "").toLowerCase();
  const size = Number(payload.size ?? 0);
  const kind = fileKind(contentType);
  if (!kind) return Response.json({ error: "지원하지 않는 이미지 또는 동영상 파일입니다." }, { status: 415 });
  if (!Number.isInteger(size) || size < 1 || size > kind.limit) {
    return Response.json({ error: "파일 크기를 확인해 주세요." }, { status: 413 });
  }

  const key = `${crypto.randomUUID()}.${kind.extension}`;
  const reservation = crypto.randomUUID();
  await Promise.all([
    pruneUploadQuota(env.DB).catch(() => undefined),
    prunePendingMedia(env.DB, bucket).catch(() => undefined),
  ]);
  const reserved = await reserveUploadQuota(env.DB, reservation, identity.actorKey, size, identity.limits);
  if (!reserved) {
    return Response.json({ error: "시간당 첨부 한도를 초과했습니다." }, {
      status: 429,
      headers: { "Retry-After": "3600" },
    });
  }
  try {
    await recordPendingMedia(env.DB, {
      key,
      ownerKey: identity.actorKey,
      mediaType: kind.mediaType,
      contentType,
      sizeBytes: size,
    });
    const uploadUrl = await bucket.createPresignedPutUrl(key, { expiresIn: 300, contentType });
    return Response.json({ direct: true, uploadUrl, key, reservation, expiresIn: 300 });
  } catch (error) {
    await discardPendingMedia(env.DB, bucket, key).catch(() => undefined);
    await releaseUploadQuota(env.DB, reservation).catch(() => undefined);
    throw error;
  }
}

export async function POST(request: Request) {
  const bucket = (env as unknown as { MEDIA?: MediaBucket }).MEDIA;
  if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });

  if (request.headers.get("content-type")?.includes("application/json")) {
    try {
      return await prepareDirectUpload(request, bucket);
    } catch (error) {
      console.error("Direct media upload failed", error);
      return Response.json({ error: "파일 업로드 중 오류가 발생했습니다." }, { status: 500 });
    }
  }

  let quotaReservation = "";
  let rollbackQuota = false;
  let pendingKey = "";
  const identity = await uploadIdentity(request);
  if (!identity) return Response.json({ error: "로그인 후 파일을 첨부할 수 있습니다." }, { status: 401 });
  const distributedLimit = await consumeDistributedRateLimit(env.CACHE, "media-upload", identity.actorKey, 600, 3_600);
  if (distributedLimit && !distributedLimit.allowed) return distributedRateLimitResponse(distributedLimit);
  const releaseUploadSlot = uploadConcurrencyGate.tryAcquire();
  if (!releaseUploadSlot) {
    return Response.json({ error: "현재 파일 첨부 요청이 많습니다. 잠시 후 다시 시도해 주세요." }, {
      status: 429,
      headers: { "Retry-After": "3" },
    });
  }

  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return Response.json({ error: "첨부할 파일을 선택해 주세요." }, { status: 400 });
    const kind = fileKind(file.type);
    if (!kind) return Response.json({ error: "지원하지 않는 이미지 또는 동영상 파일입니다." }, { status: 415 });
    if (file.size > kind.limit) {
      return Response.json({ error: kind.mediaType === "image" ? "이미지는 12MB 이하여야 합니다." : "동영상은 50MB 이하여야 합니다." }, { status: 413 });
    }

    const key = `${crypto.randomUUID()}.${kind.extension}`;
    quotaReservation = crypto.randomUUID();
    await Promise.all([
      pruneUploadQuota(env.DB).catch(() => undefined),
      prunePendingMedia(env.DB, bucket).catch(() => undefined),
    ]);
    const reserved = await reserveUploadQuota(
      env.DB,
      quotaReservation,
      identity.actorKey,
      file.size,
      identity.limits,
    );
    if (!reserved) {
      return Response.json({ error: "시간당 첨부 한도를 초과했습니다." }, {
        status: 429,
        headers: { "Retry-After": "3600" },
      });
    }
    rollbackQuota = true;
    await recordPendingMedia(env.DB, {
      key,
      ownerKey: identity.actorKey,
      mediaType: kind.mediaType,
      contentType: file.type,
      sizeBytes: file.size,
    });
    pendingKey = key;
    await bucket.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
      customMetadata: {
        uploader: identity.member
          ? `member:${identity.member.id}`
          : `admin:${identity.operator!.username}`,
        originalName: file.name.slice(0, 160),
      },
    });
    rollbackQuota = false;
    return Response.json({
      url: `/api/media/${key}`,
      mediaType: kind.mediaType,
      name: file.name,
      size: file.size,
    }, { status: 201 });
  } catch (error) {
    if (pendingKey) await discardPendingMedia(env.DB, bucket, pendingKey).catch(() => undefined);
    if (rollbackQuota && quotaReservation) await releaseUploadQuota(env.DB, quotaReservation).catch(() => undefined);
    console.error("Media upload failed", error);
    return Response.json({ error: "파일 첨부 중 오류가 발생했습니다." }, { status: 500 });
  } finally {
    releaseUploadSlot();
  }
}
