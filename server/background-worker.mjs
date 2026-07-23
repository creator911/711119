import { env } from "cloudflare:workers";
import { runRetentionMaintenance } from "./retention.mjs";
import { settleEventLeaderboard } from "../app/lib/event-leaderboard.ts";

const workerId = `${process.env.HOSTNAME || "worker"}:${process.pid}:${crypto.randomUUID()}`;
const pollMilliseconds = Math.max(100, Number(process.env.WORKER_POLL_MS || 500));
const batchSize = Math.max(1, Math.min(100, Number(process.env.WORKER_BATCH_SIZE || 20)));
const eventRefreshMilliseconds = Math.max(60_000, Number(process.env.EVENT_REFRESH_MS || 300_000));
const maintenanceMilliseconds = Math.max(60_000, Number(process.env.MAINTENANCE_INTERVAL_MS || 300_000));
let stopping = false;
let nextEventRefresh = 0;
let nextMaintenance = 0;

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function claimJob() {
  const candidate = await env.DB.prepare(`
    SELECT id,topic,payload,attempts
    FROM outbox_jobs
    WHERE status='pending' AND available_at<=?
    ORDER BY id ASC
    LIMIT 1
  `).bind(new Date().toISOString()).first();
  if (!candidate) return null;
  const lockedAt = new Date().toISOString();
  const claimed = await env.DB.prepare(`
    UPDATE outbox_jobs
    SET status='processing',locked_at=?,locked_by=?,attempts=attempts+1
    WHERE id=? AND status='pending'
  `).bind(lockedAt, workerId, candidate.id).run();
  return Number(claimed.meta.changes) === 1 ? candidate : null;
}

async function refreshLeaderboards() {
  for (const period of ["weekly", "monthly"]) {
    await settleEventLeaderboard(env.DB, period);
  }
}

async function processJob(job) {
  const payload = JSON.parse(job.payload || "{}");
  if (job.topic === "refresh_event_leaderboard") {
    await refreshLeaderboards();
    return;
  }
  if (job.topic === "post_views") {
    const entries = Object.entries(payload.views ?? {})
      .map(([postId, count]) => [Number(postId), Number(count)])
      .filter(([postId, count]) => Number.isInteger(postId) && postId > 0 && Number.isInteger(count) && count > 0);
    if (entries.length) {
      await env.DB.batch(entries.map(([postId, count]) => env.DB
        .prepare("UPDATE posts SET views=views+? WHERE id=? AND status='published'")
        .bind(count, postId)));
    }
    return;
  }
  if (job.topic === "prune_retention") {
    const completedBefore = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    await env.DB.prepare(`
      DELETE FROM outbox_jobs
      WHERE rowid IN (
        SELECT rowid FROM outbox_jobs
        WHERE status IN ('complete','failed') AND completed_at<?
        ORDER BY completed_at,id
        LIMIT 1000
      )
    `).bind(completedBefore).run();
    return;
  }
  throw new Error(`Unsupported outbox topic: ${job.topic}`);
}

async function settle(job, error) {
  const completedAt = new Date().toISOString();
  if (!error) {
    await env.DB.prepare(`
      UPDATE outbox_jobs
      SET status='complete',completed_at=?,locked_at=NULL,locked_by=NULL,last_error=NULL
      WHERE id=? AND status='processing' AND locked_by=?
    `).bind(completedAt, job.id, workerId).run();
    return;
  }
  const attempts = Number(job.attempts ?? 0) + 1;
  const terminal = attempts >= 8;
  const retryAt = new Date(Date.now() + Math.min(3_600_000, 1_000 * (2 ** Math.min(attempts, 10)))).toISOString();
  await env.DB.prepare(`
    UPDATE outbox_jobs
    SET status=?,available_at=?,completed_at=?,locked_at=NULL,locked_by=NULL,last_error=?
    WHERE id=? AND status='processing' AND locked_by=?
  `).bind(
    terminal ? "failed" : "pending",
    retryAt,
    terminal ? completedAt : null,
    String(error instanceof Error ? error.message : error).slice(0, 1000),
    job.id,
    workerId,
  ).run();
}

async function recoverExpiredLeases() {
  const expired = new Date(Date.now() - 15 * 60 * 1_000).toISOString();
  await env.DB.prepare(`
    UPDATE outbox_jobs
    SET status='pending',locked_at=NULL,locked_by=NULL,available_at=?
    WHERE status='processing' AND locked_at<?
  `).bind(new Date().toISOString(), expired).run();
}

async function loop() {
  await recoverExpiredLeases();
  while (!stopping) {
    if (env.CACHE) {
      await env.CACHE.set("health:worker", new Date().toISOString(), { ttlSeconds: 60 })
        .catch((error) => console.error("Worker heartbeat failed", error));
    }
    if (Date.now() >= nextEventRefresh) {
      nextEventRefresh = Date.now() + eventRefreshMilliseconds;
      await refreshLeaderboards().catch((error) => console.error("Periodic leaderboard refresh failed", error));
    }
    if (Date.now() >= nextMaintenance) {
      nextMaintenance = Date.now() + maintenanceMilliseconds;
      await runRetentionMaintenance(env.DB, env.MEDIA).catch((error) => console.error("Retention maintenance failed", error));
    }
    let processed = 0;
    for (; processed < batchSize && !stopping; processed += 1) {
      const job = await claimJob();
      if (!job) break;
      try {
        await processJob(job);
        await settle(job, null);
      } catch (error) {
        console.error(`Outbox job ${job.id} failed`, error);
        await settle(job, error);
      }
    }
    if (!processed) await delay(pollMilliseconds);
  }
}

process.once("SIGINT", () => { stopping = true; });
process.once("SIGTERM", () => { stopping = true; });
await loop();
