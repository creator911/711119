import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("system announcements are admin-created and shown once only to eligible members", async () => {
  const [schema, adminRoute, nextRoute, ackRoute, memberAuth, client, adminUi, consoleSource, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/announcements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/next/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/[id]/ack/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/member-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GlobalAnnouncement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminAnnouncements.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0031_slippery_ken_ellis.sql", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /systemAnnouncementReceipts/);
  assert.match(schema, /uniqueIndex\("system_announcement_receipts_announcement_user_unique"\)/);
  assert.match(migration, /UNIQUE INDEX `system_announcement_receipts_announcement_user_unique`/);
  assert.match(adminRoute, /adminSession\(request, env\)/);
  assert.match(adminRoute, /starts_at<=?|startsAt/);
  assert.match(memberAuth, /u\.role/);
  assert.match(nextRoute, /eligibleAnnouncementMember\(member\)/);
  assert.match(nextRoute, /a\.starts_at<=\? AND a\.ends_at>\?/);
  assert.match(nextRoute, /INSERT OR IGNORE INTO system_announcement_receipts/);
  assert.match(nextRoute, /a\.requires_confirmation=1 AND r\.acknowledged_at IS NULL/);
  assert.match(ackRoute, /acknowledged_at=COALESCE/);
  assert.match(client, /60_000/);
  assert.match(client, /announcement\.requiresConfirmation/);
  assert.match(client, /role="alertdialog"/);
  assert.match(adminUi, /알림 시작 시각/);
  assert.match(adminUi, /알림 종료 시각/);
  assert.match(adminUi, /확인 필수/);
  assert.match(adminUi, /자동 닫힘/);
  assert.match(consoleSource, />전체 알림 공지</);
});
