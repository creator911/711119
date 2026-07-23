export const REQUIRED_RUNTIME_SCHEMA_OBJECTS = [
  "users",
  "posts",
  "post_comments",
  "attendance",
  "support_inquiries",
  "shop_products",
  "shop_vouchers",
  "system_announcements",
  "site_settings",
  "event_activity_rollups",
  "support_write_rate_limits",
  "shop_voucher_cleanup_queue",
  "event_rollup_cleanup_queue",
  "member_account_login_failures",
  "member_ip_login_failures",
  "event_activity_posts_insert",
  "event_activity_comments_insert",
  "event_activity_attendance_insert",
  "users_partner_requires_director_after_update",
  "event_reward_payouts_period_rank_unique",
  "shop_voucher_cleanup_queue_object_key_unique",
  "event_rollup_cleanup_period_unique",
  "event_rollup_cleanup_created_idx",
  "member_account_login_failures_updated_idx",
  "member_ip_login_failures_updated_idx",
  "admin_account_login_failures_updated_idx",
  "admin_ip_login_failures_updated_idx",
  "attendance_date_created_id_idx",
  "point_ledger_user_id_idx",
  "point_ledger_content_reward_user_reference_unique",
  "posts_draft_created_id_idx",
  "posts_deleted_retention_idx",
  "post_comments_pending_created_id_idx",
  "post_comments_post_status_id_idx",
  "sessions_expires_token_idx",
  "system_announcements_ends_id_idx",
  "outbox_jobs",
  "member_activity_stats",
  "post_stats",
  "support_stats",
  "outbox_jobs_claim_idx",
  "member_activity_attendance_insert",
  "member_activity_comment_insert",
  "support_stats_reply_insert",
  "shop_purchase_validate_before_insert",
  "shop_purchase_apply_after_insert",
  "shop_voucher_purchase_validate_before_update",
  "shop_purchase_links_validate_before_update",
  "featured_vendor_posts_prevent_delete",
] as const;

type HealthPreparedStatement = {
  first: <T>() => Promise<T | null>;
  all: <T>() => Promise<{ results: T[] }>;
  bind: (...values: string[]) => HealthPreparedStatement;
};

type HealthDatabase = { prepare: (query: string) => HealthPreparedStatement };
type HealthCache = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, options?: { ttlSeconds?: number }) => Promise<unknown>;
  delete: (...keys: string[]) => Promise<unknown>;
};
type HealthMedia = {
  list: (options?: { limit?: number }) => Promise<unknown>;
};

export type SystemHealth = {
  status: "healthy" | "degraded" | "unavailable";
  database: "ok" | "error";
  cache: "ok" | "not_configured" | "error";
  storage: "ok" | "not_configured" | "error";
  worker: "ok" | "not_configured" | "stale" | "error";
  migrations: "ready" | "outdated" | "unknown";
  application: "ready" | "not_ready";
  missingSchemaObjects: number;
  latencyMs: number;
  checkedAt: string;
};

const roundedMilliseconds = (startedAt: number) => Math.max(0, Math.round((performance.now() - startedAt) * 10) / 10);

async function schemaObjectNames(database: HealthDatabase, driver: "sqlite" | "postgres") {
  if (driver === "postgres") {
    const objects = await database.prepare(`
      SELECT table_name AS name FROM information_schema.tables WHERE table_schema=current_schema()
      UNION ALL SELECT indexname AS name FROM pg_indexes WHERE schemaname=current_schema()
      UNION ALL SELECT trigger_name AS name FROM information_schema.triggers WHERE trigger_schema=current_schema()
    `).all<{ name: string }>();
    return objects.results;
  }
  const placeholders = REQUIRED_RUNTIME_SCHEMA_OBJECTS.map(() => "?").join(",");
  const result = database.prepare(`SELECT name FROM sqlite_master WHERE name IN (${placeholders})`);
  return (await result.bind(...REQUIRED_RUNTIME_SCHEMA_OBJECTS).all<{ name: string }>()).results;
}

export async function loadSystemHealth(database: HealthDatabase, {
  driver = "sqlite",
  cache = null,
  media = null,
  requireDistributed = driver === "postgres",
  workerHeartbeatMaxAgeMs = 30_000,
}: {
  driver?: "sqlite" | "postgres";
  cache?: HealthCache | null;
  media?: HealthMedia | null;
  requireDistributed?: boolean;
  workerHeartbeatMaxAgeMs?: number;
} = {}): Promise<SystemHealth> {
  const startedAt = performance.now();
  const checkedAt = new Date().toISOString();
  try {
    const ping = await database.prepare("SELECT 1 AS ok").first<{ ok: number }>();
    if (Number(ping?.ok) !== 1) throw new Error("Database readiness query failed");

    const requiredObjects = driver === "postgres"
      ? [
          ...REQUIRED_RUNTIME_SCHEMA_OBJECTS,
          "nara_schema_migrations",
          "vendor_posts_search_trgm_idx",
          "vendor_posts_feed_cursor_idx",
        ]
      : [...REQUIRED_RUNTIME_SCHEMA_OBJECTS];
    const objects = await schemaObjectNames(database, driver);
    const present = new Set(objects.map((row) => row.name));
    const missingSchemaObjects = requiredObjects.reduce(
      (count, name) => count + (present.has(name) ? 0 : 1),
      0,
    );
    let cacheStatus: SystemHealth["cache"] = cache ? "ok" : "not_configured";
    let workerStatus: SystemHealth["worker"] = cache ? "stale" : "not_configured";
    if (cache) {
      const probeKey = `health:probe:${crypto.randomUUID()}`;
      try {
        await cache.set(probeKey, checkedAt, { ttlSeconds: 10 });
        if (await cache.get(probeKey) !== checkedAt) throw new Error("Cache readiness query failed");
        await cache.delete(probeKey);
        const heartbeat = Date.parse(String(await cache.get("health:worker") ?? ""));
        workerStatus = Number.isFinite(heartbeat) && Date.now() - heartbeat <= workerHeartbeatMaxAgeMs ? "ok" : "stale";
      } catch {
        cacheStatus = "error";
        workerStatus = "error";
      }
    }
    let storageStatus: SystemHealth["storage"] = media ? "ok" : "not_configured";
    if (media) {
      try {
        await media.list({ limit: 1 });
      } catch {
        storageStatus = "error";
      }
    }
    const schemaReady = missingSchemaObjects === 0;
    const distributedReady = !requireDistributed
      || (cacheStatus === "ok" && storageStatus === "ok" && workerStatus === "ok");
    const ready = schemaReady && distributedReady;
    return {
      status: ready ? "healthy" : "degraded",
      database: "ok",
      cache: cacheStatus,
      storage: storageStatus,
      worker: workerStatus,
      migrations: schemaReady ? "ready" : "outdated",
      application: ready ? "ready" : "not_ready",
      missingSchemaObjects,
      latencyMs: roundedMilliseconds(startedAt),
      checkedAt,
    };
  } catch {
    return {
      status: "unavailable",
      database: "error",
      cache: cache ? "error" : "not_configured",
      storage: media ? "error" : "not_configured",
      worker: cache ? "error" : "not_configured",
      migrations: "unknown",
      application: "not_ready",
      missingSchemaObjects: REQUIRED_RUNTIME_SCHEMA_OBJECTS.length + (driver === "postgres" ? 3 : 0),
      latencyMs: roundedMilliseconds(startedAt),
      checkedAt,
    };
  }
}
