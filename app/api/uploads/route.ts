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

type MediaBucket = {
  put: (key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};

const IMAGE_LIMIT = 12 * 1024 * 1024;
const VIDEO_LIMIT = 50 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/avif": "avif", "image/bmp": "bmp",
};
const VIDEO_TYPES: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/ogg": "ogv", "video/quicktime": "mov",
};

export async function POST(request: Request) {
  let quotaReservation = "";
  let rollbackQuota = false;
  let pendingKey = "";
  let bucket: MediaBucket | null = null;
  const preferAdmin = request.headers.get("x-upload-context") === "admin";
  const preferredOperator = preferAdmin ? await adminSession(request, env) : null;
  let member = null;
  if (!preferredOperator) {
    try { member = await memberFromSession(request); } catch { /* 관리자 쿠키 확인을 계속합니다. */ }
  }
  const operator = preferredOperator ?? (member ? null : await adminSession(request, env));
  if (!member && !operator) return Response.json({ error: "로그인 후 파일을 첨부할 수 있습니다." }, { status: 401 });
  try {
    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || !file.size) return Response.json({ error: "첨부할 파일을 선택해 주세요." }, { status: 400 });
    const imageExtension = IMAGE_TYPES[file.type];
    const videoExtension = VIDEO_TYPES[file.type];
    const mediaType = imageExtension ? "image" : videoExtension ? "video" : null;
    if (!mediaType) return Response.json({ error: "지원하는 이미지 또는 동영상 파일이 아닙니다." }, { status: 415 });
    const limit = mediaType === "image" ? IMAGE_LIMIT : VIDEO_LIMIT;
    if (file.size > limit) return Response.json({ error: mediaType === "image" ? "이미지는 12MB 이하여야 합니다." : "동영상은 50MB 이하여야 합니다." }, { status: 413 });
    const extension = imageExtension ?? videoExtension;
    const key = `${crypto.randomUUID()}.${extension}`;
    bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
    if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });
    const actorKey = member ? memberMediaActorKey(member.id) : adminMediaActorKey(operator!.role, operator!.username);
    const limits = member ? MEMBER_UPLOAD_LIMITS : ADMIN_UPLOAD_LIMITS;
    quotaReservation = crypto.randomUUID();
    await Promise.all([
      pruneUploadQuota(env.DB).catch(() => undefined),
      prunePendingMedia(env.DB, bucket).catch(() => undefined),
    ]);
    const reserved = await reserveUploadQuota(env.DB, quotaReservation, actorKey, file.size, limits);
    if (!reserved) {
      return Response.json({ error: "한 시간 첨부 한도를 초과했습니다. 잠시 후 다시 시도해 주세요." }, {
        status: 429,
        headers: { "Retry-After": "3600" },
      });
    }
    rollbackQuota = true;
    await recordPendingMedia(env.DB, {
      key,
      ownerKey: actorKey,
      mediaType,
      contentType: file.type,
      sizeBytes: file.size,
    });
    pendingKey = key;
    await bucket.put(key, await file.arrayBuffer(), {
      httpMetadata: { contentType: file.type },
      customMetadata: { uploader: member ? `member:${member.id}` : `admin:${operator!.username}`, originalName: file.name.slice(0, 160) },
    });
    rollbackQuota = false;
    return Response.json({ url: `/api/media/${key}`, mediaType, name: file.name, size: file.size }, { status: 201 });
  } catch (error) {
    if (pendingKey && bucket) await discardPendingMedia(env.DB, bucket, pendingKey).catch(() => undefined);
    if (rollbackQuota && quotaReservation) await releaseUploadQuota(env.DB, quotaReservation).catch(() => undefined);
    console.error("Media upload failed", error);
    return Response.json({ error: "파일 첨부 중 오류가 발생했습니다." }, { status: 500 });
  }
}
