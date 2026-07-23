import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import { openD1Database } from "../server/d1-sqlite.mjs";

const baseUrl = process.env.TEST_BASE_URL;
const databasePath = process.env.TEST_DB_PATH;
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!baseUrl || !databasePath || !adminUsername || !adminPassword) throw new Error("TEST_BASE_URL, TEST_DB_PATH, TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");

const suffix = Date.now().toString(36);
const password = "NoticeTest!2026";
const regular = { username: `notice_${suffix}`.slice(0, 20), nickname: `알림${suffix.slice(-4)}`, level: 1 };
const levelTen = { username: `notice10_${suffix}`.slice(0, 20), nickname: `관리${suffix.slice(-4)}`, level: 10 };
const createdAnnouncementIds = [];

function seedUser(user) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100_000, 32, "sha256").toString("hex");
  const database = openD1Database(databasePath);
  try {
    database._runSync("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=?)", [user.username]);
    database._runSync("DELETE FROM users WHERE username=?", [user.username]);
    database._runSync(`
      INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,role,status,created_at)
      VALUES(?,?,?,?,?,0,?,1,'member','active',?)
    `, [user.username, user.nickname, hash, salt.toString("hex"), "192.0.2.55", user.level, new Date().toISOString()]);
  } finally { database.close(); }
}

function cleanup() {
  const database = openD1Database(databasePath);
  try {
    for (const id of createdAnnouncementIds) database._runSync("DELETE FROM system_announcements WHERE id=?", [id]);
    for (const user of [regular, levelTen]) {
      database._runSync("DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username=?)", [user.username]);
      database._runSync("DELETE FROM users WHERE username=?", [user.username]);
    }
  } finally { database.close(); }
}

const cookieOf = (response) => response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const jsonRequest = (url, options = {}) => fetch(`${baseUrl}${url}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers ?? {}) } });
const activeWindow = () => ({ startsAt: new Date(Date.now() - 60_000).toISOString(), endsAt: new Date(Date.now() + 300_000).toISOString() });
async function expectStatus(response, status, label) {
  if (response.status !== status) throw new Error(`${label}: expected ${status}, got ${response.status}: ${await response.text()}`);
}

async function createAnnouncement(adminCookie, requiresConfirmation, content) {
  const response = await jsonRequest("/api/admin/announcements", {
    method: "POST", headers: { Cookie: adminCookie }, body: JSON.stringify({ content, requiresConfirmation, ...activeWindow() }),
  });
  await expectStatus(response, 201, "create announcement");
  const result = await response.json();
  createdAnnouncementIds.push(result.announcement.id);
  return result.announcement;
}

const acknowledgeAnnouncement = (announcementId, deliveryLeaseToken, cookie) => jsonRequest(
  `/api/announcements/${announcementId}/ack`,
  {
    method: "POST",
    headers: { Cookie: cookie },
    body: JSON.stringify({ deliveryLeaseToken }),
  },
);

function expireDeliveryLease(announcementId) {
  const expiredAt = new Date(Date.now() - 60_000).toISOString();
  const database = openD1Database(databasePath);
  try {
    database._runSync(`
      UPDATE system_announcement_receipts
      SET delivered_at=?
      WHERE announcement_id=? AND user_id=(SELECT id FROM users WHERE username=?)
    `, [expiredAt, announcementId, regular.username]);
  } finally { database.close(); }
  return expiredAt;
}

try {
  seedUser(regular);
  seedUser(levelTen);

  const anonymousAdmin = await jsonRequest("/api/admin/announcements", { method: "POST", body: JSON.stringify({ content: "차단", requiresConfirmation: false, ...activeWindow() }) });
  assert.equal(anonymousAdmin.status, 401);

  const adminLogin = await jsonRequest("/api/admin/login", { method: "POST", body: JSON.stringify({ username: adminUsername, password: adminPassword }) });
  await expectStatus(adminLogin, 200, "admin login");
  const adminCookie = cookieOf(adminLogin);
  assert.match(adminCookie, /^cn_admin_session=/);

  const regularLogin = await jsonRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username: regular.username, password }) });
  await expectStatus(regularLogin, 200, "regular login");
  const regularCookie = cookieOf(regularLogin);

  const anonymousNext = await fetch(`${baseUrl}/api/announcements/next`);
  assert.deepEqual(await anonymousNext.json(), { eligible: false, announcement: null });

  const required = await createAnnouncement(adminCookie, true, `확인 필수 ${suffix}`);
  const firstRequired = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(firstRequired.announcement.id, required.id);
  assert.equal(firstRequired.announcement.requiresConfirmation, true);
  assert.ok(firstRequired.deliveryLeaseToken);
  let database = openD1Database(databasePath);
  try {
    const delivery = database._allSync("SELECT delivered_at AS deliveredAt,acknowledged_at AS acknowledgedAt FROM system_announcement_receipts WHERE announcement_id=?", [required.id]);
    assert.equal(delivery.length, 1, "loading an alert must atomically create a delivery claim");
    assert.ok(delivery[0].deliveredAt);
    assert.equal(delivery[0].acknowledgedAt, null, "delivery claim is not a display acknowledgement");
  } finally { database.close(); }
  const renewedLeaseResponse = await jsonRequest(`/api/announcements/${required.id}/lease`, {
    method: "POST",
    headers: { Cookie: regularCookie },
    body: JSON.stringify({ leaseToken: firstRequired.deliveryLeaseToken }),
  });
  await expectStatus(renewedLeaseResponse, 200, "renew displayed required announcement lease");
  const renewedLease = await renewedLeaseResponse.json();
  assert.ok(renewedLease.leaseToken);
  const staleLeaseResponse = await jsonRequest(`/api/announcements/${required.id}/lease`, {
    method: "POST",
    headers: { Cookie: regularCookie },
    body: JSON.stringify({ leaseToken: firstRequired.deliveryLeaseToken }),
  });
  await expectStatus(staleLeaseResponse, 409, "reject a stale delivery lease token");
  await expectStatus(
    await acknowledgeAnnouncement(required.id, firstRequired.deliveryLeaseToken, regularCookie),
    409,
    "a stale tab cannot acknowledge after another heartbeat rotated the token",
  );
  const repeatedRequired = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(repeatedRequired.announcement, null, "a live delivery lease suppresses the same required notice in another tab");
  assert.ok(repeatedRequired.retryAfterMs > 0 && repeatedRequired.retryAfterMs <= 30_000, "a waiting tab receives a bounded retry time");
  const expiredRequiredToken = expireDeliveryLease(required.id);
  await expectStatus(
    await acknowledgeAnnouncement(required.id, expiredRequiredToken, regularCookie),
    409,
    "an expired delivery token cannot acknowledge even before another tab reclaims it",
  );
  const retriedRequired = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(retriedRequired.announcement.id, required.id, "an unacknowledged required notice reappears after its delivery lease expires");
  const ack = await acknowledgeAnnouncement(required.id, retriedRequired.deliveryLeaseToken, regularCookie);
  await expectStatus(ack, 200, "acknowledge required announcement");
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);

  const automatic = await createAnnouncement(adminCookie, false, `자동 닫힘 ${suffix}`);
  const firstAutomatic = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(firstAutomatic.announcement.id, automatic.id);
  assert.equal(firstAutomatic.announcement.requiresConfirmation, false);
  const renewedAutomaticResponse = await jsonRequest(`/api/announcements/${automatic.id}/lease`, {
    method: "POST",
    headers: { Cookie: regularCookie },
    body: JSON.stringify({ leaseToken: firstAutomatic.deliveryLeaseToken }),
  });
  await expectStatus(renewedAutomaticResponse, 200, "automatic announcements share the delivery heartbeat lifecycle");
  const repeatedAutomatic = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(repeatedAutomatic.announcement, null, "a live delivery lease suppresses duplicate automatic rendering");
  expireDeliveryLease(automatic.id);
  const retriedAutomatic = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(retriedAutomatic.announcement.id, automatic.id, "an automatic notice remains pending until a rendered client acknowledges it");
  const automaticAck = await acknowledgeAnnouncement(automatic.id, retriedAutomatic.deliveryLeaseToken, regularCookie);
  await expectStatus(automaticAck, 200, "acknowledge displayed automatic announcement");
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);

  const skippedAutomatic = await createAnnouncement(adminCookie, false, `재시도 자동 알림 ${suffix}`);
  const laterRequired = await createAnnouncement(adminCookie, true, `후속 필수 알림 ${suffix}`);
  const blockedByAutomatic = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(blockedByAutomatic.announcement.id, skippedAutomatic.id);
  const afterSessionExclusion = await fetch(`${baseUrl}/api/announcements/next?exclude=${skippedAutomatic.id}`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(afterSessionExclusion.announcement.id, laterRequired.id, "a failed automatic alert must not block a later required alert");
  expireDeliveryLease(laterRequired.id);
  const requiredCannotBeExcluded = await fetch(`${baseUrl}/api/announcements/next?exclude=${skippedAutomatic.id},${laterRequired.id}`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(requiredCannotBeExcluded.announcement.id, laterRequired.id, "session exclusions must never suppress required alerts");
  const tooManyExclusions = Array.from({ length: 21 }, (_, index) => index + 1).join(",");
  await expectStatus(await fetch(`${baseUrl}/api/announcements/next?exclude=${tooManyExclusions}`, { headers: { Cookie: regularCookie } }), 400, "cap session exclusions");
  await expectStatus(await acknowledgeAnnouncement(laterRequired.id, requiredCannotBeExcluded.deliveryLeaseToken, regularCookie), 200, "acknowledge later required alert");
  await expectStatus(await acknowledgeAnnouncement(skippedAutomatic.id, blockedByAutomatic.deliveryLeaseToken, regularCookie), 200, "cleanup skipped automatic alert");

  const concurrent = await createAnnouncement(adminCookie, true, `concurrent lease ${suffix}`);
  const concurrentResults = await Promise.all(Array.from({ length: 8 }, () =>
    fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())
  ));
  assert.equal(
    concurrentResults.filter((result) => result.announcement?.id === concurrent.id).length,
    1,
    "concurrent /next requests for one member must grant exactly one delivery lease",
  );
  assert.equal(concurrentResults.filter((result) => result.announcement !== null).length, 1);
  assert.equal(
    (await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement,
    null,
    "the claim remains exclusive during its lease",
  );
  expireDeliveryLease(concurrent.id);
  const reclaimedConcurrent = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(reclaimedConcurrent.announcement.id, concurrent.id, "a crashed tab cannot permanently consume a claimed notice");
  await expectStatus(await acknowledgeAnnouncement(concurrent.id, reclaimedConcurrent.deliveryLeaseToken, regularCookie), 200, "acknowledge concurrent announcement");

  const activeResponse = await fetch(`${baseUrl}/api/announcements/active`);
  await expectStatus(activeResponse, 200, "load shared active announcements");
  assert.match(activeResponse.headers.get("cache-control") ?? "", /public/);
  const activeEtag = activeResponse.headers.get("etag");
  assert.ok(activeEtag);
  const notModified = await fetch(`${baseUrl}/api/announcements/active`, { headers: { "If-None-Match": activeEtag } });
  await expectStatus(notModified, 304, "reuse active announcement etag");

  const levelTenLogin = await jsonRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username: levelTen.username, password }) });
  await expectStatus(levelTenLogin, 200, "level ten login");
  const levelTenResult = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: cookieOf(levelTenLogin) } }).then((response) => response.json());
  assert.deepEqual(levelTenResult, { eligible: false, announcement: null });

  const cancelled = await createAnnouncement(adminCookie, true, `중단 알림 ${suffix}`);
  const activeBeforeCancellation = await fetch(`${baseUrl}/api/announcements/active`);
  const cancellationEtag = activeBeforeCancellation.headers.get("etag");
  assert.ok(cancellationEtag);
  assert.ok((await activeBeforeCancellation.json()).announcements.some((item) => item.id === cancelled.id));
  const beforeCancellation = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(beforeCancellation.announcement.id, cancelled.id);
  const cancelResponse = await jsonRequest(`/api/admin/announcements/${cancelled.id}`, { method: "PATCH", headers: { Cookie: adminCookie }, body: JSON.stringify({ status: "cancelled" }) });
  await expectStatus(cancelResponse, 200, "cancel announcement");
  const activeAfterCancellation = await fetch(`${baseUrl}/api/announcements/active`, { headers: { "If-None-Match": cancellationEtag } });
  await expectStatus(activeAfterCancellation, 200, "admin cancellation invalidates the server active snapshot");
  assert.ok(!(await activeAfterCancellation.json()).announcements.some((item) => item.id === cancelled.id));
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);
  const cancelledAck = await acknowledgeAnnouncement(cancelled.id, beforeCancellation.deliveryLeaseToken, regularCookie);
  await expectStatus(cancelledAck, 409, "cancelled announcement cannot be acknowledged");

  const expired = await createAnnouncement(adminCookie, true, `종료 알림 ${suffix}`);
  const beforeExpiry = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(beforeExpiry.announcement.id, expired.id);
  database = openD1Database(databasePath);
  try {
    database._runSync("UPDATE system_announcements SET ends_at=?,updated_at=? WHERE id=?", [
      new Date(Date.now() - 1_000).toISOString(), new Date().toISOString(), expired.id,
    ]);
  } finally { database.close(); }
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);
  const expiredAck = await acknowledgeAnnouncement(expired.id, beforeExpiry.deliveryLeaseToken, regularCookie);
  await expectStatus(expiredAck, 409, "expired announcement cannot be acknowledged");

  database = openD1Database(databasePath);
  try {
    const receipts = database._allSync("SELECT announcement_id AS announcementId,acknowledged_at AS acknowledgedAt FROM system_announcement_receipts WHERE announcement_id IN (?,?) ORDER BY announcement_id", [required.id, automatic.id]);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((item) => item.acknowledgedAt));
  } finally { database.close(); }

  console.log("전체 알림 공지 통합 검증 통과: 관리자 권한, 세션 제외 상한·필수 보호, 캐시 무효화, 표시 후 확인 기록, Lv.10 제외, 중단·종료");
} finally {
  cleanup();
}
