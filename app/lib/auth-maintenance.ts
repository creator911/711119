type MaintenanceDatabase = {
  prepare(query: string): {
    bind(...values: unknown[]): {
      first<T>(): Promise<T | null>;
      run(): Promise<unknown>;
    };
  };
};

const boundedLimit = (value: number, maximum: number) => Math.max(1, Math.min(maximum, Math.trunc(value)));

export async function pruneExpiredSessions(
  database: MaintenanceDatabase,
  now = new Date(),
  limit = 500,
) {
  await database.prepare(`
    DELETE FROM sessions
    WHERE token IN (
      SELECT token FROM sessions
      WHERE expires_at<=?
      ORDER BY expires_at,token
      LIMIT ?
    )
  `).bind(now.toISOString(), boundedLimit(limit, 2_000)).run();
}

export async function pruneExpiredAnnouncementReceipts(
  database: MaintenanceDatabase,
  now = new Date(),
  limit = 5_000,
) {
  await database.prepare(`
    DELETE FROM system_announcement_receipts
    WHERE id IN (
      SELECT receipt_id FROM (
        SELECT r.id AS receipt_id
        FROM system_announcements a
        JOIN system_announcement_receipts r ON r.announcement_id=a.id
        WHERE a.ends_at<=?
        UNION ALL
        SELECT r.id AS receipt_id
        FROM system_announcements a
        JOIN system_announcement_receipts r ON r.announcement_id=a.id
        WHERE a.status='cancelled'
      ) expired_receipts
      LIMIT ?
    )
  `).bind(now.toISOString(), boundedLimit(limit, 10_000)).run();
}

const ANNOUNCEMENT_RECEIPT_MAINTENANCE_KEY = "maintenance:announcement-receipts";
const ANNOUNCEMENT_RECEIPT_MAINTENANCE_INTERVAL_MS = 5 * 60 * 1000;

export async function maybePruneExpiredAnnouncementReceipts(
  database: MaintenanceDatabase,
  memberId: number,
  now = new Date(),
) {
  const nowMs = now.getTime();
  const bucket = Math.floor(nowMs / ANNOUNCEMENT_RECEIPT_MAINTENANCE_INTERVAL_MS);
  if ((memberId + bucket) % 64 !== 0) return;
  const nowIso = now.toISOString();
  const leaseCutoff = new Date(nowMs - ANNOUNCEMENT_RECEIPT_MAINTENANCE_INTERVAL_MS).toISOString();
  const lease = await database.prepare(`
    INSERT INTO site_settings(key,value,updated_by,updated_at)
    VALUES(?,?,'system-maintenance',?)
    ON CONFLICT(key) DO UPDATE SET
      value=excluded.value,
      updated_by=excluded.updated_by,
      updated_at=excluded.updated_at
    WHERE site_settings.updated_at<=?
    RETURNING key
  `).bind(ANNOUNCEMENT_RECEIPT_MAINTENANCE_KEY, String(bucket), nowIso, leaseCutoff).first<{ key: string }>();
  if (!lease) return;
  await pruneExpiredAnnouncementReceipts(database, now);
}
