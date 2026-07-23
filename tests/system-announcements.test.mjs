import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("system announcements use shared polling and only write receipts after display or confirmation", async () => {
  const [schema, adminRoute, cancelRoute, activeRoute, activeCache, nextRoute, leaseRoute, ackRoute, memberAuth, client, portal, sessionClient, announcementLib, css, adminUi, consoleSource, migration] = await Promise.all([
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/announcements/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/announcements/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/active/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/system-announcement-active-cache.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/next/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/[id]/lease/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/announcements/[id]/ack/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/member-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/GlobalAnnouncement.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/member-session-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/system-announcements.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminAnnouncements.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0031_slippery_ken_ellis.sql", import.meta.url), "utf8"),
  ]);

  assert.match(schema, /systemAnnouncementReceipts/);
  assert.match(schema, /uniqueIndex\("system_announcement_receipts_announcement_user_unique"\)/);
  assert.match(migration, /UNIQUE INDEX `system_announcement_receipts_announcement_user_unique`/);
  assert.match(adminRoute, /adminSession\(request, env\)/);
  assert.match(adminRoute, /WITH recent AS/);
  assert.match(adminRoute, /FROM system_announcements ORDER BY id DESC LIMIT 100/);
  assert.match(adminRoute, /invalidateActiveAnnouncementSnapshot\(\)/);
  assert.match(cancelRoute, /invalidateActiveAnnouncementSnapshot\(\)/);
  assert.match(memberAuth, /u\.role/);

  assert.match(activeRoute, /Cache-Control.*public/);
  assert.match(activeRoute, /CDN-Cache-Control/);
  assert.match(activeRoute, /If-None-Match/);
  assert.match(activeRoute, /status:\s*304/);
  assert.match(activeRoute, /must-revalidate/);
  assert.doesNotMatch(activeRoute, /stale-while-revalidate/);
  assert.match(activeCache, /let cachedSnapshot/);
  assert.match(activeCache, /if \(snapshotRefresh\) return snapshotRefresh/);
  assert.match(activeCache, /cacheGeneration/);
  assert.doesNotMatch(activeRoute, /memberFromSession/);
  assert.doesNotMatch(activeRoute, /SELECT[^`]*content/i);

  assert.match(nextRoute, /eligibleAnnouncementMember\(member\)/);
  assert.match(nextRoute, /a\.starts_at<=\? AND a\.ends_at>\?/);
  assert.match(nextRoute, /r\.acknowledged_at IS NULL/);
  assert.match(nextRoute, /requiredOnly/);
  assert.match(nextRoute, /AND a\.requires_confirmation=1/);
  assert.match(nextRoute, /MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS/);
  assert.match(nextRoute, /a\.requires_confirmation=1 OR a\.id NOT IN/);
  assert.match(nextRoute, /requiredPrioritySql/);
  assert.match(announcementLib, /ANNOUNCEMENT_DELIVERY_LEASE_MS = 30_000/);
  assert.match(nextRoute, /INSERT INTO system_announcement_receipts/);
  assert.match(nextRoute, /ON CONFLICT\(announcement_id,user_id\) DO UPDATE SET/);
  assert.match(nextRoute, /system_announcement_receipts\.delivered_at<=\?/);
  assert.match(nextRoute, /RETURNING announcement_id AS announcementId/);
  assert.match(nextRoute, /deliveryLeaseToken: row \? now : null/);
  assert.match(nextRoute, /retryAfterMs/);
  assert.doesNotMatch(nextRoute, /acknowledged_at=excluded\.delivered_at/);
  assert.match(leaseRoute, /AND acknowledged_at IS NULL AND delivered_at=\?/);
  assert.match(leaseRoute, /a\.status='active' AND a\.starts_at<=\? AND a\.ends_at>\?/);
  assert.match(leaseRoute, /RETURNING delivered_at AS leaseToken/);
  assert.match(ackRoute, /request\.json\(\)/);
  assert.match(ackRoute, /AND delivered_at=\? AND delivered_at>\?/);
  assert.match(ackRoute, /SET acknowledged_at=COALESCE\(acknowledged_at,\?\)/);
  assert.match(ackRoute, /RETURNING acknowledged_at AS acknowledgedAt/);
  assert.match(ackRoute, /ANNOUNCEMENT_DELIVERY_LEASE_MS/);

  assert.match(client, /ANNOUNCEMENT_INITIAL_RETRY_DELAYS_MS/);
  assert.match(client, /const success = await checkActiveAnnouncements\(\)/);
  assert.match(client, /requestAnimationFrame/);
  assert.match(client, /sessionStorage\.setItem\(AUTO_EXCLUSIONS_KEY/);
  assert.match(client, /startAutomaticAcknowledgement/);
  assert.match(client, /\/api\/announcements\/\$\{id\}\/lease/);
  assert.match(client, /Math\.floor\(ANNOUNCEMENT_DELIVERY_LEASE_MS \/ 3\)/);
  assert.match(client, /deliveryLeaseTokenRef\.current = result\.leaseToken/);
  assert.match(client, /JSON\.stringify\(\{ deliveryLeaseToken \}\)/);
  assert.match(client, /deliveryLeaseTokenRef\.current !== token/);
  assert.match(client, /setLeaseExpiresAt\(Date\.parse\(result\.leaseToken\) \+ ANNOUNCEMENT_DELIVERY_LEASE_MS\)/);
  assert.match(client, /Date\.now\(\) >= leaseExpiresAt\) setLeaseValidated\(false\)/);
  assert.match(client, /if \(!announcement \|\| !deliveryLeaseTokenRef\.current\) return/);
  assert.match(client, /document\.visibilityState !== "visible"[\s\S]*?setLeaseValidated\(false\)/);
  assert.match(client, /if \(!announcement \|\| !leaseValidated\) return null/);
  assert.match(client, /announcement\.requiresConfirmation \|\| !leaseValidated/);
  assert.match(client, /setDeliveryRetryAt/);
  assert.match(client, /if \(!announcementRef\.current\) void loadNext\(true\)/);
  assert.match(client, /autoAckJobsRef\.current\.size >= MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS/);
  assert.doesNotMatch(client, /AUTO_ACK_RETRY_DELAYS_MS\[Math\.min/);
  assert.match(client, /\/api\/announcements\/active/);
  assert.match(client, /If-None-Match/);
  assert.match(client, /ANNOUNCEMENT_POLL_JITTER_MS/);
  assert.match(client, /if \(eligible !== true \|\| isAdminPath\(\)\) return/);
  assert.match(client, /if \(!authenticatedRef\.current \|\| isAdminPath\(\)\) return true/);
  assert.match(client, /currentMemberSession\(\)/);
  assert.match(client, /excluded\.length >= MAX_SESSION_ANNOUNCEMENT_EXCLUSIONS/);
  assert.match(client, /matching\.updatedAt !== current\.updatedAt/);
  assert.match(client, /Date\.parse\(announcement\.endsAt\) - Date\.now\(\)/);
  assert.match(client, /window\.setTimeout\(checkExpiry, Math\.min/);
  assert.match(client, /announcement\.requiresConfirmation/);
  assert.match(client, /role="alertdialog"/);
  assert.match(client, /!dialog\.contains\(activeElement\) \|\| !items\.includes\(activeElement\)/);
  assert.match(client, /document\.addEventListener\("focusin", recoverFocus\)/);
  assert.match(announcementLib, /ANNOUNCEMENT_ACTIVE_CACHE_SECONDS = 10/);
  assert.match(announcementLib, /ANNOUNCEMENT_POLL_BASE_MS = 300_000/);
  assert.match(announcementLib, /ANNOUNCEMENT_POLL_JITTER_MS = 60_000/);

  assert.match(portal, /publishMemberSession\(Boolean\(result\.user\), result\.user\?\.level\)/);
  assert.match(portal, /\.catch\(\(\) => \{[\s\S]*?publishMemberSession\(false\)/);
  assert.match(portal, /publishMemberSession\(true, nextViewer\.level\)/);
  assert.doesNotMatch(portal, /dispatchEvent\(new CustomEvent\("cn:member-session"/);
  assert.match(sessionClient, /window\.__cnMemberSession = snapshot/);
  assert.match(sessionClient, /announcementEligible: authenticated && \(level === undefined \|\| \(level >= 1 && level <= 9\)\)/);
  assert.ok(sessionClient.indexOf("window.__cnMemberSession = snapshot") < sessionClient.indexOf("window.dispatchEvent"), "session snapshot must be durable before the event is dispatched");
  assert.ok(client.indexOf("addEventListener(MEMBER_SESSION_EVENT") < client.indexOf("currentMemberSession()"), "listener must be installed before reading the durable initial snapshot");

  assert.match(css, /global-announcement-modal[^}]*max-height:min\(720px,calc\(100dvh - 40px\)\)/);
  assert.match(css, /global-announcement-modal>div[^}]*overflow:auto/);
  assert.match(css, /grid-template-rows:auto auto minmax\(0,1fr\) auto auto/);
  assert.match(adminUi, /알림 시작 시각/);
  assert.match(adminUi, /알림 종료 시각/);
  assert.match(adminUi, /확인 필수/);
  assert.match(adminUi, /자동 닫힘/);
  assert.match(consoleSource, />전체 알림 공지</);
});
