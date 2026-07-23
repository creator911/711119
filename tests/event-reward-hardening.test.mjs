import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("event settlement is leased, transactional and retry-safe", async () => {
  const [leaderboard, migration, repairMigration] = await Promise.all([
    readFile(new URL("../app/lib/event-leaderboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0036_faulty_midnight.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0041_moaning_demogoblin.sql", import.meta.url), "utf8"),
  ]);

  assert.match(leaderboard, /SETTLEMENT_LEASE_MS/);
  assert.match(leaderboard, /crypto\.randomUUID\(\)/);
  assert.match(leaderboard, /ON CONFLICT\(key\) DO UPDATE/);
  assert.match(leaderboard, /WHERE site_settings\.value LIKE 'pending:%'/);
  assert.match(leaderboard, /await db\.batch\(statements\)/);
  assert.match(leaderboard, /Payout rows are authoritative snapshots/);
  assert.match(leaderboard, /SELECT SUM\(p\.points\)[\s\S]*p\.user_id=users\.id[\s\S]*l\.reference=\? \|\| CAST\(p\.rank AS TEXT\)/);
  assert.match(leaderboard, /INSERT OR IGNORE INTO point_ledger[\s\S]*FROM event_reward_payouts p/);
  assert.match(leaderboard, /SET value=\?,updated_by='event-reward-settlement'/);
  const settlementClaim = leaderboard.slice(leaderboard.indexOf("async function claimSettlement"), leaderboard.indexOf("async function settlePeriod"));
  assert.match(settlementClaim, /existing\?\.value\.startsWith\("complete:"\).*return null/);
  assert.match(settlementClaim, /existing\?\.value\.startsWith\("pending:"\)[\s\S]*SETTLEMENT_LEASE_MS.*return null/);
  const settlement = leaderboard.slice(leaderboard.indexOf("async function settlePeriod"), leaderboard.indexOf("export async function loadEventLeaderboard"));
  assert.match(settlement, /const counts = await queryRankCounts\(/);
  assert.doesNotMatch(settlement, /queryCachedRankCounts/);
  assert.match(leaderboard, /SELECT 1 FROM event_reward_payouts p[\s\S]*p\.rank=\?/);
  assert.match(migration, /CREATE INDEX `event_reward_payouts_period_rank_idx`/);
  assert.match(migration, /CREATE UNIQUE INDEX `point_ledger_event_reward_user_reference_unique`[\s\S]*WHERE/);
  assert.match(repairMigration, /completed legacy payout receives|A payout snapshot is the authority/);
  assert.match(repairMigration, /lowest payout id is the first written snapshot/);
  assert.match(repairMigration, /event_reward_correction/);
  assert.match(repairMigration, /CREATE UNIQUE INDEX `event_reward_payouts_period_rank_unique`/);
  assert.match(repairMigration, /UPDATE users[\s\S]*FROM event_reward_payouts p[\s\S]*INSERT OR IGNORE INTO point_ledger/);
});

test("current leaderboard snapshots use single-flight, cross-isolate leases and stale fallback", async () => {
  const leaderboard = await readFile(new URL("../app/lib/event-leaderboard.ts", import.meta.url), "utf8");
  assert.match(leaderboard, /leaderboardRefreshes = new Map<string, Promise<CountRow\[\]>>/);
  assert.match(leaderboard, /if \(existingRefresh\) return existingRefresh/);
  assert.match(leaderboard, /existing\?\.value\.startsWith\("pending:"\)[\s\S]*LEADERBOARD_REFRESH_LEASE_MS.*return null/);
  assert.match(leaderboard, /WHERE site_settings\.value LIKE 'complete:%'/);
  assert.match(leaderboard, /waitForRankSnapshot/);
  assert.match(leaderboard, /return \(await waitForRankSnapshot\(db, snapshotKey\)\)\?\.rows \?\? \[\]/);
  assert.match(leaderboard, /if \(snapshot\) return snapshot\.rows/);
  assert.match(leaderboard, /saveRankSnapshot\(db, snapshotKey, claim, rows, new Date\(\)\)/);
  assert.match(leaderboard, /WHERE EXISTS\(SELECT 1 FROM site_settings WHERE key=\? AND value=\?\)/);
  assert.match(leaderboard, /await db\.batch\(\[/);
  const cachedPath = leaderboard.slice(leaderboard.indexOf("async function queryCachedRankCounts"), leaderboard.indexOf("async function paidUserIds"));
  assert.equal((cachedPath.match(/queryRankCounts\(/g) ?? []).length, 1);
});

test("event ranking work stays time-bounded and index-backed for large member counts", async () => {
  const [leaderboard, migration, pointSettings, route] = await Promise.all([
    readFile(new URL("../app/lib/event-leaderboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0040_late_sprite.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/point-settings.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/events/leaderboard/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(leaderboard, /FROM event_activity_rollups activity/);
  assert.doesNotMatch(leaderboard, /GROUP BY p\.author_id|GROUP BY c\.user_id|GROUP BY a\.user_id/);
  assert.equal((leaderboard.match(/LIMIT 10/g) ?? []).length >= 1, true);
  assert.match(leaderboard, /u\.status='active' AND COALESCE\(u\.level,1\) BETWEEN 1 AND 9/);
  for (const indexName of [
    "event_activity_rollups_period_user_unique",
    "event_activity_rollups_ranking_idx",
    "event_activity_rollups_period_discovery_idx",
  ]) assert.match(migration, new RegExp(indexName));
  assert.match(migration, /CREATE TRIGGER event_activity_posts_update/);
  assert.match(migration, /CREATE TRIGGER event_activity_comments_update/);
  assert.match(migration, /CREATE TRIGGER event_activity_attendance_update/);
  assert.match(leaderboard, /SETTLEMENT_PERIODS_PER_RUN = 4/);
  assert.match(leaderboard, /unsettledActivityPeriods/);
  assert.match(leaderboard, /event_reward_catchup_watermark:/);
  assert.match(migration, /event_reward_catchup_watermark:weekly/);
  assert.match(migration, /event_reward_catchup_watermark:monthly/);
  assert.equal((migration.match(/'now','-70 days'/g) ?? []).length, 6);
  assert.doesNotMatch(leaderboard, /previousPeriod\("weekly"/);
  assert.doesNotMatch(leaderboard, /previousPeriod\("monthly"/);
  const readPath = pointSettings.slice(pointSettings.indexOf("export async function loadPointSettings"), pointSettings.indexOf("export async function savePointSettings"));
  assert.doesNotMatch(readPath, /initializeSettingsTable/);
  assert.match(route, /s-maxage=30, stale-while-revalidate=60/);
});

test("admin reward period switching ignores aborted and out-of-order responses", async () => {
  const component = await readFile(new URL("../app/admin/AdminEventRewards.tsx", import.meta.url), "utf8");
  assert.match(component, /requestSequence = useRef\(0\)/);
  assert.match(component, /activeRequest\.current\?\.abort\(\)/);
  assert.match(component, /signal: controller\.signal/);
  assert.match(component, /requestId !== requestSequence\.current \|\| result\.periodType !== selected/);
  assert.match(component, /controller\.signal\.aborted \|\| requestId !== requestSequence\.current/);
});
