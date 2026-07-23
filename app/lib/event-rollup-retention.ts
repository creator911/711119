type RollupRetentionDatabase = Pick<D1Database, "prepare">;

export type SettledRollupPeriod = {
  type: "weekly" | "monthly";
  startAt: string;
};

const ROLLUP_PRUNE_BATCH_SIZE = 5_000;

const settlementKey = (period: SettledRollupPeriod, boardType: "posts" | "comments") =>
  `event_reward_settled:${period.type}:${boardType}:${period.startAt}`;

export async function enqueueSettledRollupCleanup(db: RollupRetentionDatabase, period: SettledRollupPeriod, now: Date) {
  const postsKey = settlementKey(period, "posts");
  const commentsKey = settlementKey(period, "comments");
  await db.prepare(`
    INSERT OR IGNORE INTO event_rollup_cleanup_queue(period_type,period_start,created_at)
    SELECT ?,?,?
    WHERE EXISTS(SELECT 1 FROM event_activity_rollups WHERE period_type=? AND period_start=? LIMIT 1)
      AND EXISTS(SELECT 1 FROM site_settings WHERE key=? AND value LIKE 'complete:%')
      AND EXISTS(SELECT 1 FROM site_settings WHERE key=? AND value LIKE 'complete:%')
  `).bind(period.type, period.startAt, now.toISOString(), period.type, period.startAt, postsKey, commentsKey).run();
}

export async function pruneSettledEventRollups(db: RollupRetentionDatabase) {
  const queued = await db.prepare(`
    SELECT period_type AS periodType,period_start AS periodStart
    FROM event_rollup_cleanup_queue
    ORDER BY created_at,period_type,period_start
    LIMIT 1
  `).first<{ periodType: "weekly" | "monthly"; periodStart: string }>();
  if (!queued) return;

  await db.prepare(`
    DELETE FROM event_activity_rollups
    WHERE rowid IN(
      SELECT rowid FROM event_activity_rollups
      WHERE period_type=? AND period_start=?
      LIMIT ?
    )
  `).bind(queued.periodType, queued.periodStart, ROLLUP_PRUNE_BATCH_SIZE).run();
  await db.prepare(`
    DELETE FROM event_rollup_cleanup_queue
    WHERE period_type=? AND period_start=?
      AND NOT EXISTS(
        SELECT 1 FROM event_activity_rollups
        WHERE period_type=? AND period_start=?
      )
  `).bind(queued.periodType, queued.periodStart, queued.periodType, queued.periodStart).run();
}
