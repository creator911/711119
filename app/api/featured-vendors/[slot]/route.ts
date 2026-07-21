import { env } from "cloudflare:workers";
import { featuredVendorAccess } from "../../../lib/featured-vendor-auth";
import { isFeaturedVendorSlot, publicFeaturedVendor, type FeaturedVendorRow } from "../../../lib/featured-vendors";
import { normalizeRichBody } from "../../../lib/rich-text";
import {
  bodyMediaFinalizeStatements,
  discardPendingMedia,
  mediaLifecycleErrorStatus,
  prunePendingMedia,
  recordPendingMedia,
  reserveBodyMedia,
  rollbackBodyMedia,
  type MediaAttachmentClaim,
} from "../../../lib/media-lifecycle";
import { mediaActorKey } from "../../../lib/media-actor";
import {
  ADMIN_UPLOAD_LIMITS,
  MEMBER_UPLOAD_LIMITS,
  pruneUploadQuota,
  releaseUploadQuota,
  reserveUploadQuota,
} from "../../../lib/upload-quota";
import { isVendorCategory, isVendorRegion } from "../../../lib/vendor-regions";

type MediaBucket = {
  put: (key: string, value: ArrayBuffer, options: { httpMetadata: { contentType: string }; customMetadata: Record<string, string> }) => Promise<unknown>;
  delete: (key: string) => Promise<unknown>;
};

const slotOf = async (context: { params: Promise<{ slot: string }> }) => Number((await context.params).slot);
const IMAGE_LIMIT = 8 * 1024 * 1024;

const webpDimensions = (bytes: Uint8Array) => {
  if (bytes.length < 30 || new TextDecoder().decode(bytes.slice(0, 4)) !== "RIFF" || new TextDecoder().decode(bytes.slice(8, 12)) !== "WEBP") return null;
  const chunk = new TextDecoder().decode(bytes.slice(12, 16));
  if (chunk === "VP8X" && bytes.length >= 30) {
    return {
      width: 1 + bytes[24] + (bytes[25] << 8) + (bytes[26] << 16),
      height: 1 + bytes[27] + (bytes[28] << 8) + (bytes[29] << 16),
    };
  }
  if (chunk === "VP8L" && bytes.length >= 25 && bytes[20] === 0x2f) {
    return {
      width: 1 + bytes[21] + ((bytes[22] & 0x3f) << 8),
      height: 1 + ((bytes[22] & 0xc0) >> 6) + (bytes[23] << 2) + ((bytes[24] & 0x0f) << 10),
    };
  }
  if (chunk === "VP8 " && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    return { width: (bytes[26] | bytes[27] << 8) & 0x3fff, height: (bytes[28] | bytes[29] << 8) & 0x3fff };
  }
  return null;
};

const rowBySlot = (slot: number) => env.DB.prepare(`
  SELECT slot,industry,region,district,title,body,cover_key AS coverKey,version,
         created_at AS createdAt,updated_at AS updatedAt
  FROM featured_vendor_posts WHERE slot=?
`).bind(slot).first<FeaturedVendorRow>();

export async function GET(request: Request, context: { params: Promise<{ slot: string }> }) {
  const slot = await slotOf(context);
  if (!isFeaturedVendorSlot(slot)) return Response.json({ error: "추천 업체 번호를 확인해 주세요." }, { status: 404 });
  try {
    const [row, access] = await Promise.all([rowBySlot(slot), featuredVendorAccess(request)]);
    if (!row) return Response.json({ error: "추천 업체를 찾을 수 없습니다." }, { status: 404 });
    return Response.json({ post: publicFeaturedVendor(row, access.editableSlots.includes(slot)) }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("Featured vendor detail load failed", error);
    return Response.json({ error: "추천 업체를 불러오지 못했습니다." }, { status: 500 });
  }
}

export async function PATCH(request: Request, context: { params: Promise<{ slot: string }> }) {
  const slot = await slotOf(context);
  if (!isFeaturedVendorSlot(slot)) return Response.json({ error: "추천 업체 번호를 확인해 주세요." }, { status: 404 });
  let uploadedKey = "";
  let updateCommitted = false;
  let mediaClaim: MediaAttachmentClaim | null = null;
  let quotaReservation = "";
  let rollbackCoverQuota = false;
  let coverMetadataKey = "";
  try {
    const access = await featuredVendorAccess(request);
    if (!access.actor) return Response.json({ error: "로그인 후 수정할 수 있습니다." }, { status: 401 });
    if (!access.editableSlots.includes(slot)) return Response.json({ error: `${slot}번 추천 업체의 수정 권한이 없습니다.` }, { status: 403 });

    const current = await rowBySlot(slot);
    if (!current) return Response.json({ error: "추천 업체를 찾을 수 없습니다." }, { status: 404 });
    const form = await request.formData();
    const industry = String(form.get("industry") ?? "").trim();
    const region = String(form.get("region") ?? "").trim();
    const district = String(form.get("district") ?? "").trim();
    const title = String(form.get("title") ?? "").trim().replace(/\s+/g, " ");
    const sourceBody = String(form.get("body") ?? "");
    const version = Number(form.get("version"));
    if (form.has("coverUrl")) return Response.json({ error: "대문 이미지는 파일로 직접 첨부해 주세요." }, { status: 400 });
    if (!Number.isInteger(version) || version < 1) return Response.json({ error: "수정 중인 글의 버전을 확인해 주세요." }, { status: 400 });
    if (version !== current.version) return Response.json({ error: "다른 사용자가 먼저 수정했습니다. 최신 내용을 다시 불러와 주세요." }, { status: 409 });
    if (!isVendorCategory(industry)) return Response.json({ error: "업종을 하나만 선택해 주세요." }, { status: 400 });
    if (!isVendorRegion(region, district)) return Response.json({ error: "상세지역을 하나만 선택해 주세요." }, { status: 400 });
    if (title.length < 2 || title.length > 80) return Response.json({ error: "제목은 2~80자로 입력해 주세요." }, { status: 400 });
    if (/<(?:img|video)\b[^>]*\bsrc\s*=\s*(?:["']\s*)?https?:/i.test(sourceBody)) return Response.json({ error: "본문 이미지는 직접 첨부한 파일만 사용할 수 있습니다." }, { status: 400 });
    const { body, textLength } = normalizeRichBody(sourceBody);
    if (/<(?:img|video)\b[^>]*\bsrc="https?:/i.test(body)) return Response.json({ error: "본문 이미지는 직접 첨부한 파일만 사용할 수 있습니다." }, { status: 400 });
    const hasMedia = /<(?:img|video|iframe)\b/i.test(body);
    if (/post-poll-slot/i.test(body)) return Response.json({ error: "추천 업체 글에는 투표를 넣을 수 없습니다." }, { status: 400 });
    if ((textLength < 2 && !hasMedia) || textLength > 3000 || body.length > 20000) return Response.json({ error: "내용은 2~3,000자로 입력해 주세요." }, { status: 400 });

    const actorKey = await mediaActorKey(request, env);
    if (!actorKey) return Response.json({ error: "로그인 후 수정할 수 있습니다." }, { status: 401 });
    let nextCoverKey = current.coverKey;
    const cover = form.get("cover");
    if (cover !== null && !(cover instanceof File)) return Response.json({ error: "대문 이미지 파일 형식을 확인해 주세요." }, { status: 400 });
    if (cover instanceof File && cover.size) {
      if (cover.size > IMAGE_LIMIT) return Response.json({ error: "대문 이미지는 8MB 이하여야 합니다." }, { status: 413 });
      if (cover.type !== "image/webp") return Response.json({ error: "자르기를 적용한 WebP 이미지만 저장할 수 있습니다." }, { status: 415 });
      const buffer = await cover.arrayBuffer();
      const dimensions = webpDimensions(new Uint8Array(buffer));
      if (!dimensions || dimensions.width !== 1600 || dimensions.height !== 1000) return Response.json({ error: "대문 이미지는 1600×1000 비율로 잘라서 저장해 주세요." }, { status: 415 });
      uploadedKey = `${crypto.randomUUID()}.webp`;
      const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
      if (!bucket) return Response.json({ error: "파일 저장소가 설정되지 않았습니다." }, { status: 503 });
      const limits = actorKey.startsWith("member:") ? MEMBER_UPLOAD_LIMITS : ADMIN_UPLOAD_LIMITS;
      quotaReservation = crypto.randomUUID();
      await Promise.all([
        pruneUploadQuota(env.DB).catch(() => undefined),
        prunePendingMedia(env.DB, bucket).catch(() => undefined),
      ]);
      const reserved = await reserveUploadQuota(env.DB, quotaReservation, actorKey, cover.size, limits);
      if (!reserved) {
        return Response.json({ error: "한 시간 첨부 한도를 초과했습니다. 잠시 후 다시 시도해 주세요." }, {
          status: 429,
          headers: { "Retry-After": "3600" },
        });
      }
      rollbackCoverQuota = true;
      await recordPendingMedia(env.DB, {
        key: uploadedKey,
        ownerKey: actorKey,
        mediaType: "image",
        contentType: "image/webp",
        sizeBytes: cover.size,
      });
      coverMetadataKey = uploadedKey;
      await bucket.put(uploadedKey, buffer, {
        httpMetadata: { contentType: "image/webp" },
        customMetadata: { uploader: access.actor.label, purpose: `featured-vendor:${slot}`, originalName: cover.name.slice(0, 160) },
      });
      nextCoverKey = uploadedKey;
    }

    const coverTag = nextCoverKey ? `<img src="/api/media/${nextCoverKey}" />` : "";
    const previousCoverTag = current.coverKey ? `<img src="/api/media/${current.coverKey}" />` : "";
    mediaClaim = await reserveBodyMedia(env.DB, actorKey, `${body}${coverTag}`, `${current.body}${previousCoverTag}`);

    const now = new Date().toISOString();
    const values = [industry, region, district, title, body, nextCoverKey, access.actor.label, now, slot, version] as const;
    const updateStatement = access.actor.type === "admin"
      ? env.DB.prepare(`
          UPDATE featured_vendor_posts
          SET industry=?,region=?,district=?,title=?,body=?,cover_key=?,updated_by=?,updated_at=?,version=version+1
          WHERE slot=? AND version=?
        `).bind(...values)
      : access.actor.member.level === 10
        ? env.DB.prepare(`
            UPDATE featured_vendor_posts
            SET industry=?,region=?,district=?,title=?,body=?,cover_key=?,updated_by=?,updated_at=?,version=version+1
            WHERE slot=? AND version=? AND EXISTS(
              SELECT 1 FROM users u WHERE u.id=? AND u.status='active' AND u.level=10
            )
          `).bind(...values, access.actor.member.id)
      : env.DB.prepare(`
          UPDATE featured_vendor_posts
          SET industry=?,region=?,district=?,title=?,body=?,cover_key=?,updated_by=?,updated_at=?,version=version+1
          WHERE slot=? AND version=? AND EXISTS(
            SELECT 1 FROM users u JOIN featured_vendor_permissions p ON p.user_id=u.id
            WHERE u.id=? AND u.status='active' AND u.is_director=1 AND u.is_partner=1 AND p.slot=featured_vendor_posts.slot
          )
        `).bind(...values, access.actor.member.id);
    const results = await env.DB.batch([
      updateStatement,
      ...bodyMediaFinalizeStatements(env.DB, mediaClaim, "featured", slot, body, now, { version: version + 1, coverKey: nextCoverKey }),
    ]);
    const result = results[0];

    const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
    if (!result.meta.changes) {
      await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
      mediaClaim = null;
      if (uploadedKey && bucket && coverMetadataKey) await discardPendingMedia(env.DB, bucket, coverMetadataKey).catch(() => undefined);
      if (rollbackCoverQuota && quotaReservation) await releaseUploadQuota(env.DB, quotaReservation).catch(() => undefined);
      rollbackCoverQuota = false;
      const refreshed = await featuredVendorAccess(request);
      return Response.json({ error: refreshed.editableSlots.includes(slot) ? "다른 사용자가 먼저 수정했습니다. 최신 내용을 다시 불러와 주세요." : "수정 권한이 변경되었습니다." }, { status: refreshed.editableSlots.includes(slot) ? 409 : 403 });
    }
    updateCommitted = true;
    rollbackCoverQuota = false;
    if (uploadedKey && current.coverKey && current.coverKey !== uploadedKey && bucket) {
      await discardPendingMedia(env.DB, bucket, current.coverKey).catch(() => undefined);
    }
    const saved = await rowBySlot(slot);
    if (!saved) throw new Error("Saved featured vendor missing");
    return Response.json({ post: publicFeaturedVendor(saved, true) });
  } catch (error) {
    if (mediaClaim && !updateCommitted) await rollbackBodyMedia(env.DB, mediaClaim).catch(() => undefined);
    if (uploadedKey && !updateCommitted) {
      const bucket = (env as unknown as { MEDIA: MediaBucket }).MEDIA;
      if (bucket && coverMetadataKey) await discardPendingMedia(env.DB, bucket, coverMetadataKey).catch(() => undefined);
      else if (bucket) await bucket.delete(uploadedKey).catch(() => undefined);
    }
    if (rollbackCoverQuota && quotaReservation) await releaseUploadQuota(env.DB, quotaReservation).catch(() => undefined);
    const mediaStatus = mediaLifecycleErrorStatus(error);
    if (mediaStatus) return Response.json({ error: (error as Error).message }, { status: mediaStatus });
    console.error("Featured vendor update failed", error);
    return Response.json({ error: "추천 업체 글을 수정하지 못했습니다." }, { status: 500 });
  }
}
