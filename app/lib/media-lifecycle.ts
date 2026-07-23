export const PENDING_MEDIA_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PENDING_MEDIA_PRUNE_LIMIT = 12;

type MediaDatabase = Pick<D1Database, "prepare" | "batch">;

type MediaBucket = { delete: (key: string) => Promise<unknown> };

type MediaRow = {
  key: string;
  ownerKey: string;
  status: "pending" | "attaching" | "attached" | "pruning";
};

export type MediaAttachmentClaim = {
  actorKey: string;
  token: string;
  keys: string[];
  attachedKeys: string[];
  trackedKeys: string[];
  previousKeys: string[];
};

export type MediaResourceType = "post" | "vendor" | "support" | "featured";

const mediaResources = {
  post: { table: "posts", id: "id", active: "status='published'" },
  vendor: { table: "vendor_posts", id: "id", active: "status='published'" },
  support: { table: "support_inquiries", id: "id", active: "status!='deleted'" },
  featured: { table: "featured_vendor_posts", id: "slot", active: "1=1" },
} as const;

const orphanedAttachedStatement = (database: MediaDatabase, detachedAt: string, limit = PENDING_MEDIA_PRUNE_LIMIT) => database.prepare(`
  UPDATE uploaded_media
  SET status='pending',created_at=?,attached_at=NULL,claim_token=NULL,claimed_at=NULL
  WHERE key IN (
    SELECT m.key FROM uploaded_media m
    WHERE m.status='attached'
      AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=m.key)
    ORDER BY COALESCE(m.attached_at,m.created_at) ASC LIMIT ?
  )
`).bind(detachedAt, Math.max(1, Math.min(PENDING_MEDIA_PRUNE_LIMIT, Math.trunc(limit))));

export class MediaOwnershipError extends Error {
  constructor(message = "첨부 파일을 사용할 권한이 없습니다.") {
    super(message);
    this.name = "MediaOwnershipError";
  }
}

export class MediaUnavailableError extends Error {
  constructor(message = "첨부 파일이 만료되었거나 다른 요청에서 처리 중입니다. 다시 첨부해 주세요.") {
    super(message);
    this.name = "MediaUnavailableError";
  }
}

export function mediaLifecycleErrorStatus(error: unknown) {
  if (error instanceof MediaOwnershipError) return 403;
  if (error instanceof MediaUnavailableError) return 409;
  return null;
}

export const memberMediaActorKey = (memberId: number) => `member:${memberId}`;
export const adminMediaActorKey = (role: string, username: string) => `admin:${role}:${username.toLowerCase()}`;

export function bodyMediaKeys(normalizedBody: string) {
  const keys = new Set<string>();
  for (const tag of normalizedBody.matchAll(/<(?:img|video)\b[^>]*>/gi)) {
    const source = tag[0].match(/\bsrc\s*=\s*["']\/api\/(?:support\/)?media\/([0-9a-f-]{36}\.[a-z0-9]+)["']/i)?.[1];
    if (source) keys.add(source.toLowerCase());
  }
  return [...keys];
}

export async function recordPendingMedia(
  database: MediaDatabase,
  values: { key: string; ownerKey: string; mediaType: string; contentType: string; sizeBytes: number; createdAt?: string },
) {
  await database.prepare(`
    INSERT INTO uploaded_media(key,owner_key,media_type,content_type,size_bytes,status,created_at)
    VALUES(?,?,?,?,?,'pending',?)
  `).bind(
    values.key,
    values.ownerKey,
    values.mediaType,
    values.contentType,
    values.sizeBytes,
    values.createdAt ?? new Date().toISOString(),
  ).run();
}

export async function discardPendingMedia(database: MediaDatabase, bucket: MediaBucket, key: string) {
  const claimed = await database.prepare(`
    UPDATE uploaded_media SET status='pruning',claim_token=NULL,claimed_at=?
    WHERE key=? AND status='pending'
  `).bind(new Date().toISOString(), key).run();
  if (claimed.meta.changes !== 1) return false;
  try {
    await bucket.delete(key);
    await database.prepare("DELETE FROM uploaded_media WHERE key=? AND status='pruning'").bind(key).run();
    return true;
  } catch {
    await database.prepare("UPDATE uploaded_media SET status='pending',claimed_at=NULL WHERE key=? AND status='pruning'")
      .bind(key).run().catch(() => undefined);
    return false;
  }
}

export async function reserveBodyMedia(
  database: MediaDatabase,
  actorKey: string,
  normalizedBody: string,
  existingBody = "",
): Promise<MediaAttachmentClaim> {
  const keys = bodyMediaKeys(normalizedBody);
  const previousKeys = bodyMediaKeys(existingBody);
  const existingKeys = new Set(previousKeys);
  const token = crypto.randomUUID();
  const claimed: string[] = [];
  const claimedAttached: string[] = [];
  const tracked: string[] = [];

  try {
    for (const key of keys) {
      const row = await database.prepare(
        "SELECT key,owner_key AS ownerKey,status FROM uploaded_media WHERE key=?",
      ).bind(key).first<MediaRow>();
      // Objects created before this lifecycle table are treated as legacy media.
      if (!row) continue;
      // Existing attached media may remain in a body edited by an administrator,
      // but pending media can only be claimed by its uploader.
      if (row.ownerKey !== actorKey) {
        if (row.status === "attached" && existingKeys.has(key)) {
          const locked = await database.prepare(`
            UPDATE uploaded_media SET status='attaching',claim_token=?,claimed_at=?
            WHERE key=? AND status='attached'
          `).bind(token, new Date().toISOString(), key).run();
          if (locked.meta.changes !== 1) throw new MediaUnavailableError();
          claimedAttached.push(key);
          tracked.push(key);
          continue;
        }
        throw new MediaOwnershipError();
      }
      if (row.status === "attached") {
        const locked = await database.prepare(`
          UPDATE uploaded_media SET status='attaching',claim_token=?,claimed_at=?
          WHERE key=? AND owner_key=? AND status='attached'
        `).bind(token, new Date().toISOString(), key, actorKey).run();
        if (locked.meta.changes !== 1) throw new MediaUnavailableError();
        claimedAttached.push(key);
        tracked.push(key);
        continue;
      }
      if (row.status !== "pending") throw new MediaUnavailableError();
      const claimedAt = new Date().toISOString();
      const result = await database.prepare(`
        UPDATE uploaded_media
        SET status='attaching',claim_token=?,claimed_at=?
        WHERE key=? AND owner_key=? AND status='pending'
      `).bind(token, claimedAt, key, actorKey).run();
      if (result.meta.changes !== 1) throw new MediaUnavailableError();
      claimed.push(key);
      tracked.push(key);
    }
    return { actorKey, token, keys: claimed, attachedKeys: claimedAttached, trackedKeys: tracked, previousKeys };
  } catch (error) {
    await rollbackClaimRows(database, token, claimed, claimedAttached).catch(() => undefined);
    throw error;
  }
}

async function rollbackClaimRows(database: MediaDatabase, token: string, pendingKeys: string[], attachedKeys: string[]) {
  const statements = [
    ...pendingKeys.map((key) => database.prepare(`
      UPDATE uploaded_media SET status='pending',claim_token=NULL,claimed_at=NULL
      WHERE key=? AND claim_token=? AND status='attaching'
    `).bind(key, token)),
    ...attachedKeys.map((key) => database.prepare(`
      UPDATE uploaded_media SET status='attached',claim_token=NULL,claimed_at=NULL
      WHERE key=? AND claim_token=? AND status='attaching'
    `).bind(key, token)),
  ];
  if (statements.length) await database.batch(statements);
}

export function bodyMediaFinalizeStatements(
  database: MediaDatabase,
  claim: MediaAttachmentClaim,
  resourceType: MediaResourceType,
  resourceId: string | number,
  expectedBody: string,
  attachedAt = new Date().toISOString(),
  expectedFeaturedState?: { version: number; coverKey: string | null },
) {
  const id = String(resourceId);
  const resource = mediaResources[resourceType];
  const featuredGuard = resourceType === "featured" && expectedFeaturedState ? " AND version=? AND cover_key IS ?" : "";
  const guard = `EXISTS(SELECT 1 FROM ${resource.table} WHERE ${resource.id}=CAST(? AS INTEGER) AND body=? AND ${resource.active}${featuredGuard})`;
  const guardValues = featuredGuard ? [id, expectedBody, expectedFeaturedState!.version, expectedFeaturedState!.coverKey] : [id, expectedBody];
  return [
    database.prepare(`DELETE FROM uploaded_media_references WHERE resource_type=? AND resource_id=? AND ${guard}`)
      .bind(resourceType, id, ...guardValues),
    ...claim.trackedKeys.map((key) => database.prepare(`
      INSERT OR IGNORE INTO uploaded_media_references(media_key,resource_type,resource_id,created_at)
      SELECT key,?,?,? FROM uploaded_media
      WHERE key=? AND status IN ('attaching','attached') AND ${guard}
    `).bind(resourceType, id, attachedAt, key, ...guardValues)),
    database.prepare(`
      UPDATE uploaded_media
      SET status='attached',attached_at=?,claim_token=NULL,claimed_at=NULL
      WHERE claim_token=? AND status='attaching' AND ${guard}
    `).bind(attachedAt, claim.token, ...guardValues),
    ...claim.previousKeys.map((key) => database.prepare(`
      UPDATE uploaded_media
      SET status='pending',created_at=?,attached_at=NULL,claim_token=NULL,claimed_at=NULL
      WHERE key=? AND status='attached'
        AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key)
        AND ${guard}
    `).bind(attachedAt, key, ...guardValues)),
    // Covers last-write-wins races where a concurrent update attached a key
    // that was not present in this request's previous body snapshot.
    orphanedAttachedStatement(database, attachedAt),
  ];
}

export async function finalizeBodyMedia(
  database: MediaDatabase,
  claim: MediaAttachmentClaim,
  resourceType: MediaResourceType,
  resourceId: string | number,
  expectedBody: string,
  attachedAt = new Date().toISOString(),
  expectedFeaturedState?: { version: number; coverKey: string | null },
) {
  await database.batch(bodyMediaFinalizeStatements(database, claim, resourceType, resourceId, expectedBody, attachedAt, expectedFeaturedState));
}

export function supportReplyMediaFinalizeStatements(
  database: MediaDatabase,
  claim: MediaAttachmentClaim,
  inquiryId: number,
  replyId: number,
  expectedBody: string,
  attachedAt = new Date().toISOString(),
) {
  const guard = `EXISTS(
    SELECT 1 FROM support_inquiry_replies r
    JOIN support_inquiries i ON i.id=r.inquiry_id
    WHERE r.id=CAST(? AS INTEGER) AND r.inquiry_id=CAST(? AS INTEGER) AND r.body=? AND i.status!='deleted'
  )`;
  const guardValues = [String(replyId), String(inquiryId), expectedBody];
  return [
    ...claim.trackedKeys.map((key) => database.prepare(`
      INSERT OR IGNORE INTO uploaded_media_references(media_key,resource_type,resource_id,created_at)
      SELECT key,'support',?,? FROM uploaded_media
      WHERE key=? AND status IN ('attaching','attached') AND ${guard}
    `).bind(String(inquiryId), attachedAt, key, ...guardValues)),
    database.prepare(`
      UPDATE uploaded_media
      SET status='attached',attached_at=?,claim_token=NULL,claimed_at=NULL
      WHERE claim_token=? AND status='attaching' AND ${guard}
    `).bind(attachedAt, claim.token, ...guardValues),
    orphanedAttachedStatement(database, attachedAt),
  ];
}

export async function rollbackBodyMedia(database: MediaDatabase, claim: MediaAttachmentClaim) {
  await rollbackClaimRows(database, claim.token, claim.keys, claim.attachedKeys);
}

export async function bodyMediaReleaseStatements(
  database: MediaDatabase,
  resourceType: MediaResourceType,
  resourceId: string | number,
  releasedAt = new Date().toISOString(),
) {
  const id = String(resourceId);
  const references = await database.prepare(`
    SELECT media_key AS mediaKey FROM uploaded_media_references
    WHERE resource_type=? AND resource_id=?
  `).bind(resourceType, id).all<{ mediaKey: string }>();
  const goneGuard = resourceType === "post"
    ? "EXISTS(SELECT 1 FROM posts WHERE id=CAST(? AS INTEGER) AND status!='published')"
    : resourceType === "vendor"
      ? "NOT EXISTS(SELECT 1 FROM vendor_posts WHERE id=CAST(? AS INTEGER))"
      : resourceType === "support"
        ? "EXISTS(SELECT 1 FROM support_inquiries WHERE id=CAST(? AS INTEGER) AND status='deleted')"
        : "NOT EXISTS(SELECT 1 FROM featured_vendor_posts WHERE slot=CAST(? AS INTEGER))";
  return [
    database.prepare(`DELETE FROM uploaded_media_references WHERE resource_type=? AND resource_id=? AND ${goneGuard}`)
      .bind(resourceType, id, id),
    ...references.results.map(({ mediaKey }) => database.prepare(`
      UPDATE uploaded_media
      SET status='pending',created_at=?,attached_at=NULL,claim_token=NULL,claimed_at=NULL
      WHERE key=? AND status='attached'
        AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key)
        AND ${goneGuard}
    `).bind(releasedAt, mediaKey, id)),
    // Covers a new reference committed after the pre-batch reference read.
    orphanedAttachedStatement(database, releasedAt),
  ];
}

export async function releaseBodyMediaReferences(
  database: MediaDatabase,
  resourceType: MediaResourceType,
  resourceId: string | number,
  releasedAt = new Date().toISOString(),
) {
  const statements = await bodyMediaReleaseStatements(database, resourceType, resourceId, releasedAt);
  if (statements.length) await database.batch(statements);
}

async function recoverStaleAttachment(database: MediaDatabase, key: string, cutoff: string, recoveredAt: string) {
  const mediaUrl = `/api/media/${key}`;
  const supportMediaUrl = `/api/support/media/${key}`;
  const resources = await database.prepare(`
    SELECT 'post' AS resourceType,CAST(id AS TEXT) AS resourceId FROM posts
      WHERE status='published' AND instr(body,?)>0
    UNION ALL
    SELECT 'vendor',CAST(id AS TEXT) FROM vendor_posts
      WHERE status='published' AND instr(body,?)>0
    UNION ALL
    SELECT 'support',CAST(i.id AS TEXT) FROM support_inquiries i
      WHERE i.status!='deleted' AND (
        instr(i.body,?)>0 OR EXISTS(
          SELECT 1 FROM support_inquiry_replies sr
          WHERE sr.inquiry_id=i.id AND (instr(sr.body,?)>0 OR instr(sr.body,?)>0)
        )
      )
    UNION ALL
    SELECT 'featured',CAST(slot AS TEXT) FROM featured_vendor_posts
      WHERE instr(body,?)>0 OR cover_key=?
  `).bind(mediaUrl, mediaUrl, mediaUrl, mediaUrl, supportMediaUrl, mediaUrl, key).all<{ resourceType: MediaResourceType; resourceId: string }>();

  if (resources.results.length) {
    const results = await database.batch([
      ...resources.results.map(({ resourceType, resourceId }) => {
        const resource = mediaResources[resourceType];
        const mediaGuard = resourceType === "featured"
          ? "(instr(body,?)>0 OR cover_key=?)"
          : resourceType === "support"
            ? `(instr(body,?)>0 OR EXISTS(
                SELECT 1 FROM support_inquiry_replies sr
                WHERE sr.inquiry_id=support_inquiries.id AND (instr(sr.body,?)>0 OR instr(sr.body,?)>0)
              ))`
            : "instr(body,?)>0";
        const mediaGuardValues = resourceType === "featured" ? [mediaUrl, key] : resourceType === "support" ? [mediaUrl, mediaUrl, supportMediaUrl] : [mediaUrl];
        return database.prepare(`
        INSERT OR IGNORE INTO uploaded_media_references(media_key,resource_type,resource_id,created_at)
        SELECT key,?,?,? FROM uploaded_media
        WHERE key=? AND status='attaching' AND claimed_at<?
          AND EXISTS(
            SELECT 1 FROM ${resource.table}
            WHERE ${resource.id}=CAST(? AS INTEGER) AND ${resource.active} AND ${mediaGuard}
          )
      `).bind(resourceType, resourceId, recoveredAt, key, cutoff, resourceId, ...mediaGuardValues);
      }),
      database.prepare(`
        UPDATE uploaded_media
        SET status='attached',attached_at=?,claim_token=NULL,claimed_at=NULL
        WHERE key=? AND status='attaching' AND claimed_at<?
          AND EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key)
      `).bind(recoveredAt, key, cutoff),
    ]);
    if (results.at(-1)?.meta.changes) return true;
  }

  await database.prepare(`
    UPDATE uploaded_media
    SET status='pending',created_at=COALESCE(claimed_at,created_at),claim_token=NULL,claimed_at=NULL
    WHERE key=? AND status='attaching' AND claimed_at<?
  `).bind(key, cutoff).run();
  return false;
}

export async function prunePendingMedia(
  database: MediaDatabase,
  bucket: MediaBucket,
  nowMs = Date.now(),
  limit = PENDING_MEDIA_PRUNE_LIMIT,
) {
  const boundedLimit = Math.max(1, Math.min(PENDING_MEDIA_PRUNE_LIMIT, Math.trunc(limit)));
  const pruneStartedAt = new Date(nowMs).toISOString();
  await orphanedAttachedStatement(database, pruneStartedAt, boundedLimit).run();
  const cutoff = new Date(nowMs - PENDING_MEDIA_TTL_MS).toISOString();
  const candidates = await database.prepare(`
    SELECT key,status FROM uploaded_media
    WHERE (status='pending' AND created_at<?
           AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key))
       OR (status='attaching' AND claimed_at<?)
       OR (status='pruning' AND claimed_at<?)
    ORDER BY COALESCE(claimed_at,created_at) ASC LIMIT ?
  `).bind(cutoff, cutoff, cutoff, boundedLimit).all<{ key: string; status: string }>();
  let deleted = 0;

  for (const candidate of candidates.results) {
    if (candidate.status === "attaching" && await recoverStaleAttachment(database, candidate.key, cutoff, new Date(nowMs).toISOString())) {
      continue;
    }
    if (candidate.status !== "pruning") {
      const claimed = await database.prepare(`
        UPDATE uploaded_media SET status='pruning',claim_token=NULL,claimed_at=?
        WHERE key=? AND status='pending' AND created_at<?
          AND NOT EXISTS(SELECT 1 FROM uploaded_media_references r WHERE r.media_key=uploaded_media.key)
      `).bind(new Date(nowMs).toISOString(), candidate.key, cutoff).run();
      if (claimed.meta.changes !== 1) continue;
    }
    try {
      await bucket.delete(candidate.key);
      const removed = await database.prepare("DELETE FROM uploaded_media WHERE key=? AND status='pruning'").bind(candidate.key).run();
      deleted += removed.meta.changes;
    } catch {
      await database.prepare(`
        UPDATE uploaded_media SET status='pending',claimed_at=NULL
        WHERE key=? AND status='pruning'
      `).bind(candidate.key).run().catch(() => undefined);
    }
  }
  return deleted;
}
