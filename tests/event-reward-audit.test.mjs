import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin event reward audit keeps payout snapshots and renders twelve compact rank slots", async () => {
  const [schema, migration, leaderboard, route, component, consoleSource, styles] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0032_lively_vertigo.sql", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/event-leaderboard.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/event-rewards/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminEventRewards.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /nicknameSnapshot: text\("nickname_snapshot"\)/);
  assert.match(schema, /levelSnapshot: integer\("level_snapshot"\)/);
  assert.match(migration, /ADD `nickname_snapshot` text/);
  assert.match(migration, /ADD `level_snapshot` integer/);
  assert.match(leaderboard, /row\.nickname, row\.level, nowIso/);
  assert.match(leaderboard, /COALESCE\(NULLIF\(p\.nickname_snapshot,''\),u\.nickname\)/);
  assert.match(leaderboard, /loadAdminEventRewardAudit/);
  assert.match(route, /adminSession\(request, env\)/);
  assert.match(route, /loadAdminEventRewardAudit\(env\.DB, period\)/);
  assert.match(component, /지난 지급 결과 6명과 현재 예상 수상자 6명/);
  assert.match(component, /\(\["posts", "comments"\] as const\)\.map/);
  assert.match(component, /\[1, 2, 3\]\.map/);
  assert.match(component, /Lv\.\{row\?\.level/);
  assert.match(component, /row\.points\.toLocaleString\(\)/);
  assert.match(consoleSource, /<AdminEventRewards \/>/);
  assert.match(styles, /\.event-reward-audit \{ grid-column:1 \/ -1;/);
  assert.match(styles, /\.event-reward-periods \{ display:grid; grid-template-columns:repeat\(2/);
});
