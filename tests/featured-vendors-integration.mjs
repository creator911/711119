import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

const baseHostname = new URL(baseUrl).hostname;
const localHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!localHostnames.has(baseHostname) && process.env.ALLOW_REMOTE_FEATURED_VENDOR_INTEGRATION !== "1") {
  throw new Error(
    `Refusing to run featured vendor integration tests against non-local host "${baseHostname}". ` +
      "Set ALLOW_REMOTE_FEATURED_VENDOR_INTEGRATION=1 only when remote test data is explicitly intended.",
  );
}

if (!adminUsername || !adminPassword) {
  throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
}

const unique = Date.now().toString(36);
const password = "SafePass!2026";
const testIps = {
  affiliateA: "192.0.2.231",
  affiliateB: "192.0.2.232",
  outsider: "192.0.2.233",
  admin: process.env.TEST_ADMIN_IP || "192.0.2.234",
};

async function readJson(response) {
  const text = await response.clone().text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: ${JSON.stringify(await readJson(response))}`);
  return response;
}

async function expectRejected(response, statuses, label) {
  assert.ok(statuses.includes(response.status), `${label}: expected ${statuses.join("/")}, got ${response.status}: ${JSON.stringify(await readJson(response))}`);
  return response;
}

async function getCaptcha() {
  const response = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}-${Math.random()}`);
  await expectStatus(response, 200, "captcha load");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const svg = await response.text();
  const answer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
  assert.match(answer, /^\d{5}$/);
  return { answer, cookie };
}

async function registerAndLogin(usernamePrefix, nicknamePrefix, ip) {
  const captcha = await getCaptcha();
  const username = `${usernamePrefix}${unique}`.slice(0, 20);
  const nickname = `${nicknamePrefix}${unique}`.slice(0, 12);
  const registration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: captcha.cookie, "X-Forwarded-For": ip },
    body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer: captcha.answer }),
  });
  await expectStatus(registration, 201, `${usernamePrefix} registration`);

  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ username, password }),
  });
  await expectStatus(login, 200, `${usernamePrefix} login`);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(cookie, /^cn_session=/);
  return { username, nickname, cookie };
}

async function adminLogin() {
  const response = await fetch(`${baseUrl}/api/admin/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": testIps.admin },
    body: JSON.stringify({ username: adminUsername, password: adminPassword }),
  });
  await expectStatus(response, 200, "admin login");
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(cookie, /^cn_admin_session=/);
  return cookie;
}

async function loadOverview(adminCookie) {
  const response = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie }, cache: "no-store" });
  await expectStatus(response, 200, "admin overview");
  return response.json();
}

async function memberByUsername(adminCookie, username) {
  const overview = await loadOverview(adminCookie);
  const member = overview.members.find((item) => item.username === username);
  assert.ok(member, `member ${username} must be present in the admin overview`);
  assert.equal(typeof member.isDirector, "boolean", "overview isDirector must be Boolean");
  assert.equal(typeof member.isPartner, "boolean", "overview isPartner must be Boolean");
  return member;
}

async function updateMember(adminCookie, username, changes, expectedStatus = 200) {
  const member = await memberByUsername(adminCookie, username);
  const response = await fetch(`${baseUrl}/api/admin/members`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      id: member.id,
      nickname: member.nickname,
      points: Number(member.points),
      level: Number(member.level),
      status: member.status,
      isDirector: member.isDirector,
      isPartner: member.isPartner,
      ...changes,
    }),
  });
  await expectStatus(response, expectedStatus, `member update (${username})`);
  return member;
}

async function loadPermissions(adminCookie) {
  const response = await fetch(`${baseUrl}/api/admin/featured-vendor-permissions`, {
    headers: adminCookie ? { Cookie: adminCookie } : {},
    cache: "no-store",
  });
  return { response, data: await readJson(response) };
}

async function savePermissions(adminCookie, userId, slots) {
  return fetch(`${baseUrl}/api/admin/featured-vendor-permissions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...(adminCookie ? { Cookie: adminCookie } : {}) },
    body: JSON.stringify({ userId, slots }),
  });
}

async function loadFeatured(cookie = "") {
  const response = await fetch(`${baseUrl}/api/featured-vendors`, {
    headers: cookie ? { Cookie: cookie } : {},
    cache: "no-store",
  });
  await expectStatus(response, 200, "featured vendor list");
  const data = await response.json();
  assert.ok(Array.isArray(data.posts), "featured vendor response must contain a posts array");
  return data;
}

async function loadSlot(slot, cookie = "") {
  const data = await loadFeatured(cookie);
  const post = data.posts.find((item) => Number(item.slot) === slot);
  assert.ok(post, `featured vendor slot ${slot} must exist`);
  return post;
}

function editableState(post) {
  return {
    slot: Number(post.slot),
    industry: post.industry,
    region: post.region,
    district: post.district,
    title: post.title,
    body: post.body,
    coverImage: post.coverImage,
    version: Number(post.version),
  };
}

function patchForm(post, changes = {}) {
  const form = new FormData();
  form.set("industry", String(changes.industry ?? post.industry));
  form.set("region", String(changes.region ?? post.region));
  form.set("district", String(changes.district ?? post.district));
  form.set("title", String(changes.title ?? post.title));
  form.set("body", String(changes.body ?? post.body));
  form.set("version", String(changes.version ?? post.version));
  return form;
}

async function patchSlot(cookie, slot, post, changes = {}, mutateForm) {
  const form = patchForm(post, changes);
  mutateForm?.(form);
  return fetch(`${baseUrl}/api/featured-vendors/${slot}`, {
    method: "PATCH",
    headers: cookie ? { Cookie: cookie } : {},
    body: form,
  });
}

async function assertSlotUnchanged(slot, before, label) {
  const after = editableState(await loadSlot(slot));
  assert.deepEqual(after, editableState(before), label);
}

function slotsForUser(permissionData, userId) {
  return permissionData.assignments
    .filter((item) => Number(item.userId) === Number(userId))
    .map((item) => Number(item.slot))
    .sort((left, right) => left - right);
}

let cleanupAdminCookie = "";
const cleanupUsernames = [];
let originalSlots = [];

try {
  const anonymousPermissionList = await loadPermissions("");
  await expectStatus(anonymousPermissionList.response, 401, "anonymous permission list guard");

  const anonymousPermissionUpdate = await savePermissions("", 1, [1]);
  await expectStatus(anonymousPermissionUpdate, 401, "anonymous permission update guard");

  const affiliateA = await registerAndLogin("fva", "제휴A", testIps.affiliateA);
  const affiliateB = await registerAndLogin("fvb", "제휴B", testIps.affiliateB);
  const outsider = await registerAndLogin("fvo", "일반검증", testIps.outsider);
  cleanupUsernames.push(affiliateA.username, affiliateB.username, outsider.username);

  const adminCookie = await adminLogin();
  cleanupAdminCookie = adminCookie;

  const initialFeatured = await loadFeatured();
  assert.equal(initialFeatured.posts.length, 4, "the public featured vendor list must contain exactly four fixed slots");
  assert.deepEqual(initialFeatured.posts.map((post) => Number(post.slot)), [1, 2, 3, 4], "featured vendor slots must be ordered 1 through 4");
  assert.equal(JSON.stringify(initialFeatured).includes('"userId"'), false, "public featured vendor data must not expose assigned user IDs");
  assert.equal(JSON.stringify(initialFeatured).includes('"authorId"'), false, "public featured vendor data must not expose author IDs");
  for (const post of initialFeatured.posts) {
    assert.ok(Number.isInteger(Number(post.version)) && Number(post.version) >= 1, `slot ${post.slot} must expose a positive concurrency version`);
    assert.notEqual(post.canDelete, true, `slot ${post.slot} must never advertise delete permission`);
  }
  originalSlots = initialFeatured.posts.map((post) => editableState(post));

  const anonymousSlotEdit = await patchSlot("", 1, initialFeatured.posts[0], { title: `익명 침범 ${unique}` });
  await expectStatus(anonymousSlotEdit, 401, "anonymous featured vendor edit guard");
  await assertSlotUnchanged(1, initialFeatured.posts[0], "slot 1 must remain unchanged after an anonymous attempt");

  const outsiderMember = await memberByUsername(adminCookie, outsider.username);
  const prematurePartner = await fetch(`${baseUrl}/api/admin/members`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: adminCookie },
    body: JSON.stringify({
      id: outsiderMember.id,
      nickname: outsiderMember.nickname,
      points: Number(outsiderMember.points),
      level: Number(outsiderMember.level),
      status: outsiderMember.status,
      isDirector: false,
      isPartner: true,
    }),
  });
  await expectStatus(prematurePartner, 409, "partner designation requires director first");

  const nonPartnerPermission = await savePermissions(adminCookie, outsiderMember.id, [1]);
  await expectStatus(nonPartnerPermission, 409, "non-partner permission assignment guard");

  await updateMember(adminCookie, affiliateA.username, { isDirector: true, isPartner: false });
  await updateMember(adminCookie, affiliateA.username, { isPartner: true });
  await updateMember(adminCookie, affiliateB.username, { isDirector: true, isPartner: false });
  await updateMember(adminCookie, affiliateB.username, { isPartner: true });

  const affiliateAMember = await memberByUsername(adminCookie, affiliateA.username);
  const affiliateBMember = await memberByUsername(adminCookie, affiliateB.username);

  const saveA = await savePermissions(adminCookie, affiliateAMember.id, [1, 2, 3]);
  await expectStatus(saveA, 200, "affiliate A multi-slot assignment");
  assert.deepEqual((await saveA.json()).slots, [1, 2, 3]);

  const saveB = await savePermissions(adminCookie, affiliateBMember.id, [1, 1, 4]);
  await expectStatus(saveB, 200, "affiliate B overlapping slot assignment");
  assert.deepEqual((await saveB.json()).slots, [1, 4], "duplicate slots must be normalized without blocking a shared slot");

  const permissionList = await loadPermissions(adminCookie);
  await expectStatus(permissionList.response, 200, "permission list after assignments");
  assert.ok(Array.isArray(permissionList.data.affiliates));
  assert.ok(Array.isArray(permissionList.data.assignments));
  assert.deepEqual(slotsForUser(permissionList.data, affiliateAMember.id), [1, 2, 3]);
  assert.deepEqual(slotsForUser(permissionList.data, affiliateBMember.id), [1, 4]);

  const affiliateAView = await loadFeatured(affiliateA.cookie);
  assert.deepEqual(
    affiliateAView.posts.filter((post) => post.canEdit).map((post) => Number(post.slot)),
    [1, 2, 3],
    "affiliate A must only receive edit controls for its assigned slots",
  );
  const affiliateBView = await loadFeatured(affiliateB.cookie);
  assert.deepEqual(
    affiliateBView.posts.filter((post) => post.canEdit).map((post) => Number(post.slot)),
    [1, 4],
    "affiliate B must receive both its own slot and the overlapping shared slot",
  );

  const invalidPermissions = await savePermissions(adminCookie, affiliateAMember.id, [0, 5]);
  await expectStatus(invalidPermissions, 400, "invalid slot assignment validation");
  const permissionsAfterInvalid = await loadPermissions(adminCookie);
  await expectStatus(permissionsAfterInvalid.response, 200, "permissions after invalid update");
  assert.deepEqual(slotsForUser(permissionsAfterInvalid.data, affiliateAMember.id), [1, 2, 3], "invalid permission input must not replace existing assignments");

  const slot4BeforeForbidden = await loadSlot(4);
  const forbiddenSlot4 = await patchSlot(affiliateA.cookie, 4, slot4BeforeForbidden, { title: `A의 4번 침범 ${unique}` });
  await expectStatus(forbiddenSlot4, 403, "affiliate A cannot edit unassigned slot 4");
  await assertSlotUnchanged(4, slot4BeforeForbidden, "slot 4 must remain unchanged after affiliate A's forbidden attempt");

  const slot2BeforeUnassigned = await loadSlot(2);
  const unassignedPartnerEdit = await patchSlot(affiliateB.cookie, 2, slot2BeforeUnassigned, { title: `B의 미배정 침범 ${unique}` });
  await expectStatus(unassignedPartnerEdit, 403, "active partner cannot edit an unassigned slot");
  await assertSlotUnchanged(2, slot2BeforeUnassigned, "slot 2 must remain unchanged after an unassigned partner attempt");

  const slot1BeforeOutsider = await loadSlot(1);
  const outsiderEdit = await patchSlot(outsider.cookie, 1, slot1BeforeOutsider, { title: `일반회원 침범 ${unique}` });
  await expectStatus(outsiderEdit, 403, "ordinary member edit guard");
  await assertSlotUnchanged(1, slot1BeforeOutsider, "slot 1 must remain unchanged after an ordinary member attempt");

  const slot1BeforeA = await loadSlot(1);
  const affiliateATitle = `제휴 A 1번 수정 ${unique}`;
  const affiliateAEdit = await patchSlot(affiliateA.cookie, 1, slot1BeforeA, {
    title: affiliateATitle,
    body: `<p>제휴 A가 배정된 1번 슬롯만 수정했습니다. ${unique}</p>`,
  });
  await expectStatus(affiliateAEdit, 200, "affiliate A assigned slot edit");
  const affiliateAEditData = await affiliateAEdit.json();
  assert.equal(Number(affiliateAEditData.post.slot), 1);
  assert.equal(affiliateAEditData.post.title, affiliateATitle);
  assert.equal(Number(affiliateAEditData.post.version), Number(slot1BeforeA.version) + 1);

  const slot4BeforeB = await loadSlot(4);
  const affiliateBTitle = `제휴 B 4번 수정 ${unique}`;
  const affiliateBEdit = await patchSlot(affiliateB.cookie, 4, slot4BeforeB, {
    title: affiliateBTitle,
    body: `<p>제휴 B가 배정된 4번 슬롯을 수정했습니다. ${unique}</p>`,
  });
  await expectStatus(affiliateBEdit, 200, "affiliate B assigned slot edit");
  assert.equal((await affiliateBEdit.json()).post.title, affiliateBTitle);

  const slot1BeforeFreshUpdate = await loadSlot(1);
  const freshTitle = `동시수정 최신본 ${unique}`;
  const freshUpdate = await patchSlot(affiliateA.cookie, 1, slot1BeforeFreshUpdate, { title: freshTitle });
  await expectStatus(freshUpdate, 200, "fresh optimistic update");
  const slot1AfterFreshUpdate = await loadSlot(1);
  assert.equal(slot1AfterFreshUpdate.title, freshTitle);
  assert.equal(Number(slot1AfterFreshUpdate.version), Number(slot1BeforeFreshUpdate.version) + 1);

  const staleUpdate = await patchSlot(affiliateA.cookie, 1, slot1BeforeFreshUpdate, { title: `오래된 수정 ${unique}` });
  await expectStatus(staleUpdate, 409, "stale optimistic update guard");
  const slot1AfterStaleUpdate = await loadSlot(1);
  assert.equal(slot1AfterStaleUpdate.title, freshTitle, "a stale request must not overwrite the latest title");
  assert.equal(Number(slot1AfterStaleUpdate.version), Number(slot1AfterFreshUpdate.version), "a stale request must not increment the version");

  const slot1BeforeInvalid = await loadSlot(1);
  await expectStatus(await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, { industry: "전체" }), 400, "invalid writable industry");
  await assertSlotUnchanged(1, slot1BeforeInvalid, "invalid industry must not change slot 1");
  await expectStatus(await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, { title: "한" }), 400, "invalid title length");
  await assertSlotUnchanged(1, slot1BeforeInvalid, "invalid title must not change slot 1");
  await expectStatus(
    await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, { region: "서울 강남", district: "영등포" }),
    400,
    "invalid region and district pair",
  );
  await assertSlotUnchanged(1, slot1BeforeInvalid, "invalid region pair must not change slot 1");
  await expectStatus(
    await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, {
      body: `<p>외부 추적 이미지는 저장되지 않아야 합니다.</p><img src="https://evil.example/tracker.gif" onerror="alert(1)">`,
    }),
    400,
    "external body image injection guard",
  );
  await assertSlotUnchanged(1, slot1BeforeInvalid, "external body media must not change slot 1");
  await expectStatus(
    await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, {
      body: `<p>따옴표가 없는 외부 이미지 주소도 저장되지 않아야 합니다.</p><img src=https://evil.example/tracker.gif>`,
    }),
    400,
    "unquoted external body image injection guard",
  );
  await assertSlotUnchanged(1, slot1BeforeInvalid, "unquoted external body media must not change slot 1");

  const externalCover = await patchSlot(affiliateA.cookie, 1, slot1BeforeInvalid, {}, (form) => {
    form.set("cover", "https://evil.example/tracker.jpg");
    form.set("coverUrl", "https://evil.example/forced-cover.jpg");
  });
  await expectRejected(externalCover, [400, 415], "external cover URL injection guard");
  await assertSlotUnchanged(1, slot1BeforeInvalid, "external cover URL fields must not change slot 1");

  const invalidSlotEdit = await patchSlot(affiliateA.cookie, 5, slot1BeforeInvalid, { title: `없는 슬롯 ${unique}` });
  await expectRejected(invalidSlotEdit, [400, 404], "invalid featured slot path");

  await updateMember(adminCookie, affiliateA.username, { status: "suspended" });
  const slot2BeforeSuspended = await loadSlot(2);
  const suspendedEdit = await patchSlot(affiliateA.cookie, 2, slot2BeforeSuspended, { title: `정지회원 침범 ${unique}` });
  await expectRejected(suspendedEdit, [401, 403], "suspended affiliate edit guard");
  await assertSlotUnchanged(2, slot2BeforeSuspended, "a suspended affiliate must not change an assigned slot");
  await updateMember(adminCookie, affiliateA.username, { status: "active" });

  await updateMember(adminCookie, outsider.username, { level: 10 });
  const slot3BeforeLevelTen = await loadSlot(3);
  const levelTenTitle = `Lv10 전 슬롯 수정 ${unique}`;
  const levelTenEdit = await patchSlot(outsider.cookie, 3, slot3BeforeLevelTen, { title: levelTenTitle });
  await expectStatus(levelTenEdit, 200, "Lv.10 member all-slot edit");
  assert.equal((await levelTenEdit.json()).post.title, levelTenTitle);
  await updateMember(adminCookie, outsider.username, { level: 1 });

  const slot2BeforeAdmin = await loadSlot(2);
  const adminTitle = `관리자 전 슬롯 수정 ${unique}`;
  const adminEdit = await patchSlot(adminCookie, 2, slot2BeforeAdmin, { title: adminTitle });
  await expectStatus(adminEdit, 200, "separate admin session all-slot edit");
  assert.equal((await adminEdit.json()).post.title, adminTitle);

  const slot3BeforeCombinedAdmin = await loadSlot(3);
  const combinedAdminTitle = `일반회원·관리자 동시세션 ${unique}`;
  const combinedAdminEdit = await patchSlot(
    `${outsider.cookie}; ${adminCookie}`,
    3,
    slot3BeforeCombinedAdmin,
    { title: combinedAdminTitle },
  );
  await expectStatus(combinedAdminEdit, 200, "admin authority survives an additional ordinary member cookie");
  assert.equal((await combinedAdminEdit.json()).post.title, combinedAdminTitle);

  const memberDelete = await fetch(`${baseUrl}/api/featured-vendors/1`, { method: "DELETE", headers: { Cookie: affiliateA.cookie } });
  await expectStatus(memberDelete, 405, "affiliate cannot delete a fixed slot");
  const adminDelete = await fetch(`${baseUrl}/api/featured-vendors/1`, { method: "DELETE", headers: { Cookie: adminCookie } });
  await expectStatus(adminDelete, 405, "admin cannot delete a fixed slot");
  assert.ok(await loadSlot(1), "slot 1 must still exist after delete attempts");

  await updateMember(adminCookie, affiliateA.username, { isPartner: false });
  const permissionsAfterPartnerRemoval = await loadPermissions(adminCookie);
  await expectStatus(permissionsAfterPartnerRemoval.response, 200, "permissions after partner removal");
  assert.deepEqual(slotsForUser(permissionsAfterPartnerRemoval.data, affiliateAMember.id), [], "partner removal must clear all slot assignments");
  const slot1BeforeRemovedPartner = await loadSlot(1);
  const removedPartnerEdit = await patchSlot(affiliateA.cookie, 1, slot1BeforeRemovedPartner, { title: `제휴해제 침범 ${unique}` });
  await expectStatus(removedPartnerEdit, 403, "removed partner permission guard");
  await assertSlotUnchanged(1, slot1BeforeRemovedPartner, "a removed partner must not change its former slot");

  await updateMember(adminCookie, affiliateA.username, { isPartner: true });
  await expectStatus(await savePermissions(adminCookie, affiliateAMember.id, [1]), 200, "restore one assignment before director removal");
  await updateMember(adminCookie, affiliateA.username, { isDirector: false, isPartner: false });
  const permissionsAfterDirectorRemoval = await loadPermissions(adminCookie);
  await expectStatus(permissionsAfterDirectorRemoval.response, 200, "permissions after director removal");
  assert.deepEqual(slotsForUser(permissionsAfterDirectorRemoval.data, affiliateAMember.id), [], "director removal must clear all slot assignments");
  const slot1BeforeRemovedDirector = await loadSlot(1);
  const removedDirectorEdit = await patchSlot(affiliateA.cookie, 1, slot1BeforeRemovedDirector, { title: `실장해제 침범 ${unique}` });
  await expectStatus(removedDirectorEdit, 403, "removed director permission guard");
  await assertSlotUnchanged(1, slot1BeforeRemovedDirector, "a removed director must not change its former slot");

  console.log("제휴 추천업체 검증 통과: 고정 4슬롯, 다중·중복 배정, 슬롯 격리, 관리자/Lv.10 권한, 낙관적 잠금, 삭제·외부이미지·잘못된 입력 차단, 권한 회수");
} finally {
  if (cleanupAdminCookie) {
    try {
      for (const original of originalSlots) {
        const current = await loadSlot(original.slot);
        const restore = await patchSlot(cleanupAdminCookie, original.slot, current, {
          industry: original.industry,
          region: original.region,
          district: original.district,
          title: original.title,
          body: original.body,
        });
        if (!restore.ok) console.error(`Featured slot ${original.slot} cleanup failed:`, await readJson(restore));
      }

      for (const username of cleanupUsernames) {
        const member = await memberByUsername(cleanupAdminCookie, username);
        if (member.isDirector && member.isPartner && member.status === "active") {
          const clearPermissions = await savePermissions(cleanupAdminCookie, member.id, []);
          if (!clearPermissions.ok) console.error(`Permission cleanup failed for ${username}:`, await readJson(clearPermissions));
        }
        await updateMember(cleanupAdminCookie, username, {
          level: 1,
          status: "suspended",
          isDirector: false,
          isPartner: false,
        });
      }
    } catch (cleanupError) {
      console.error("Featured vendor integration cleanup failed:", cleanupError);
    }
  }
}
