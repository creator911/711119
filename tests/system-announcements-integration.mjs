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
  const repeatedRequired = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(repeatedRequired.announcement.id, required.id, "unconfirmed notices must appear again");
  const ack = await fetch(`${baseUrl}/api/announcements/${required.id}/ack`, { method: "POST", headers: { Cookie: regularCookie } });
  await expectStatus(ack, 200, "acknowledge required announcement");
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);

  const automatic = await createAnnouncement(adminCookie, false, `자동 닫힘 ${suffix}`);
  const firstAutomatic = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json());
  assert.equal(firstAutomatic.announcement.id, automatic.id);
  assert.equal(firstAutomatic.announcement.requiresConfirmation, false);
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null, "automatic notices must be delivered once");

  const levelTenLogin = await jsonRequest("/api/auth/login", { method: "POST", body: JSON.stringify({ username: levelTen.username, password }) });
  await expectStatus(levelTenLogin, 200, "level ten login");
  const levelTenResult = await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: cookieOf(levelTenLogin) } }).then((response) => response.json());
  assert.deepEqual(levelTenResult, { eligible: false, announcement: null });

  const cancelled = await createAnnouncement(adminCookie, false, `중단 알림 ${suffix}`);
  const cancelResponse = await jsonRequest(`/api/admin/announcements/${cancelled.id}`, { method: "PATCH", headers: { Cookie: adminCookie }, body: JSON.stringify({ status: "cancelled" }) });
  await expectStatus(cancelResponse, 200, "cancel announcement");
  assert.equal((await fetch(`${baseUrl}/api/announcements/next`, { headers: { Cookie: regularCookie } }).then((response) => response.json())).announcement, null);

  const database = openD1Database(databasePath);
  try {
    const receipts = database._allSync("SELECT announcement_id AS announcementId,acknowledged_at AS acknowledgedAt FROM system_announcement_receipts WHERE announcement_id IN (?,?) ORDER BY announcement_id", [required.id, automatic.id]);
    assert.equal(receipts.length, 2);
    assert.ok(receipts.every((item) => item.acknowledgedAt));
  } finally { database.close(); }

  console.log("전체 알림 공지 통합 검증 통과: 관리자 권한, 기간 노출, 확인 필수 재노출, 자동 닫힘 1회, Lv.10 제외, 노출 중단");
} finally {
  cleanup();
}
