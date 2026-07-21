import assert from "node:assert/strict";
import { hasMemberLevelPermission, memberPermissionLevels } from "../app/lib/member-level.ts";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
const unique = Date.now().toString(36);
const username = `level${unique}`.slice(0, 20);
const nickname = `레벨${unique}`.slice(0, 12);
const targetUsername = `target${unique}`.slice(0, 20);
const targetNickname = `대상${unique}`.slice(0, 12);
const password = "SafePass!2026";

const captchaResponse = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
assert.equal(captchaResponse.status, 200);
const captchaCookie = captchaResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const svg = await captchaResponse.text();
const captchaAnswer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");

const register = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: captchaCookie, "X-Forwarded-For": "203.0.113.230" },
  body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer }),
});
assert.equal(register.status, 201);

const targetCaptchaResponse = await fetch(`${baseUrl}/api/captcha?t=${Date.now() + 1}`);
assert.equal(targetCaptchaResponse.status, 200);
const targetCaptchaCookie = targetCaptchaResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const targetSvg = await targetCaptchaResponse.text();
const targetCaptchaAnswer = [...targetSvg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
const targetRegister = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: targetCaptchaCookie, "X-Forwarded-For": "203.0.113.231" },
  body: JSON.stringify({ username: targetUsername, nickname: targetNickname, password, passwordConfirm: password, captchaAnswer: targetCaptchaAnswer }),
});
assert.equal(targetRegister.status, 201);

const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(adminLogin.status, 200);
const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
assert.equal(overview.status, 200);
const ownerOverview = await overview.json();
assert.equal(ownerOverview.operator.level, 10);
assert.equal(ownerOverview.operator.role, "owner");
assert.equal(ownerOverview.operator.canManageAdmins, true);
const member = ownerOverview.members.find((item) => item.username === username);
const targetMember = ownerOverview.members.find((item) => item.username === targetUsername);
assert.ok(member);
assert.ok(targetMember);
assert.equal(member.level, 1);
assert.equal(Boolean(member.isDirector), false);
assert.equal(Boolean(member.isPartner), false);

const invalidLevel = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ id: member.id, nickname, points: 0, level: 11, status: "active" }),
});
assert.equal(invalidLevel.status, 400);

const levelUpdate = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ id: member.id, nickname, points: 0, level: 7, status: "active" }),
});
assert.equal(levelUpdate.status, 200);

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": "203.0.113.230" },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200);
const loginData = await login.json();
assert.equal(loginData.user.level, 7);
const memberCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

const attendance = await fetch(`${baseUrl}/api/attendance`, { headers: { Cookie: memberCookie } });
assert.equal(attendance.status, 200);
assert.equal((await attendance.json()).user.level, 7);

const promoteToAdmin = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ id: member.id, nickname, points: 0, level: 10, status: "active" }),
});
assert.equal(promoteToAdmin.status, 200);

const levelTenLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(levelTenLogin.status, 200);
const levelTenCookie = levelTenLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

const levelTenOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: levelTenCookie } });
assert.equal(levelTenOverview.status, 200);
const levelTenOverviewData = await levelTenOverview.json();
assert.equal(levelTenOverviewData.operator.role, "level10");
assert.equal(levelTenOverviewData.operator.level, 10);
assert.equal(levelTenOverviewData.operator.canManageAdmins, false);

const levelTenEvent = await fetch(`${baseUrl}/api/admin/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: levelTenCookie },
  body: JSON.stringify({ title: `Lv.10 운영 테스트 ${unique}`, body: "Lv.10 관리자의 이벤트 운영 권한을 확인합니다." }),
});
assert.equal(levelTenEvent.status, 201);

const forbiddenPromotion = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: levelTenCookie },
  body: JSON.stringify({ id: targetMember.id, nickname: targetNickname, points: 0, level: 10, status: "active" }),
});
assert.equal(forbiddenPromotion.status, 403);

const allowedMemberManagement = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: levelTenCookie },
  body: JSON.stringify({ id: targetMember.id, nickname: targetNickname, points: 250, level: 5, status: "active", isDirector: true, isPartner: true }),
});
assert.equal(allowedMemberManagement.status, 200);

const affiliateOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: levelTenCookie } });
assert.equal(affiliateOverview.status, 200);
const affiliateMember = (await affiliateOverview.json()).members.find((item) => item.id === targetMember.id);
assert.ok(affiliateMember);
assert.equal(Boolean(affiliateMember.isDirector), true);
assert.equal(Boolean(affiliateMember.isPartner), true);

assert.deepEqual(memberPermissionLevels(1), [1]);
assert.deepEqual(memberPermissionLevels(5), [1, 5]);
assert.equal(hasMemberLevelPermission(5, 1), true);
assert.equal(hasMemberLevelPermission(5, 5), true);
assert.equal(hasMemberLevelPermission(5, 2), false);
assert.equal(hasMemberLevelPermission(5, 3), false);
assert.equal(hasMemberLevelPermission(5, 4), false);
assert.deepEqual(memberPermissionLevels(10), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
assert.equal(hasMemberLevelPermission(10, 2), true);
assert.equal(hasMemberLevelPermission(10, 9), true);

console.log("레벨 검증 통과: Lv.2–9 독립 권한, Lv.10 전체 권한·실장·제휴 지정, 오너 전용 관리자 지정·해제");
