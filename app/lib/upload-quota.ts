export const MEMBER_UPLOAD_LIMITS = { files: 20, bytes: 200 * 1024 * 1024 } as const;
export const ADMIN_UPLOAD_LIMITS = { files: 10, bytes: 100 * 1024 * 1024 } as const;
export const UPLOAD_QUOTA_WINDOW_MS = 60 * 60 * 1000;

type UploadQuotaDatabase = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      run: () => Promise<{ meta: { changes: number } }>;
    };
  };
};

type UploadLimits = { files: number; bytes: number };

export async function reserveUploadQuota(
  database: UploadQuotaDatabase,
  reservationId: string,
  actorKey: string,
  fileSize: number,
  limits: UploadLimits,
  nowMs = Date.now(),
) {
  const createdAt = new Date(nowMs).toISOString();
  const windowStart = new Date(nowMs - UPLOAD_QUOTA_WINDOW_MS).toISOString();
  const reserved = await database.prepare(`
    INSERT INTO upload_usage (id,actor_key,size_bytes,created_at)
    SELECT ?,?,?,?
    WHERE (SELECT COUNT(*) FROM upload_usage WHERE actor_key=? AND created_at>?) < ?
      AND (SELECT COALESCE(SUM(size_bytes),0) FROM upload_usage WHERE actor_key=? AND created_at>?) + ? <= ?
  `).bind(
    reservationId, actorKey, fileSize, createdAt,
    actorKey, windowStart, limits.files,
    actorKey, windowStart, fileSize, limits.bytes,
  ).run();
  return reserved.meta.changes === 1;
}

export async function releaseUploadQuota(database: UploadQuotaDatabase, reservationId: string) {
  await database.prepare("DELETE FROM upload_usage WHERE id=?").bind(reservationId).run();
}

export async function pruneUploadQuota(database: UploadQuotaDatabase, nowMs = Date.now()) {
  const cutoff = new Date(nowMs - UPLOAD_QUOTA_WINDOW_MS * 2).toISOString();
  await database.prepare("DELETE FROM upload_usage WHERE created_at<?").bind(cutoff).run();
}
