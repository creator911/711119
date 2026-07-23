import assert from "node:assert/strict";
import { openD1Database } from "../server/d1-sqlite.mjs";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const databasePath = process.env.TEST_DB_PATH;
assert.ok(databasePath, "TEST_DB_PATH가 지정된 격리 테스트 DB에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
const testIp = `198.51.100.${40 + (Date.now() % 180)}`;
const eventTitle = `관리자 이벤트 ${Date.now().toString(36)}`;

const database = openD1Database(databasePath);
try {
  for (let index = 0; index < 205; index += 1) {
    const suffix = String(index).padStart(3, "0");
    const isDirector = index % 31 === 0 ? 1 : 0;
    const isPartner = index % 62 === 0 ? 1 : 0;
    database._runSync(`
      INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,'member','active',?)
    `, [`sort-user-${suffix}`, `정렬회원${suffix}`, "test-hash", "test-salt", `192.0.2.${index % 255}`, (index % 17) * 100, index % 9 + 1, isDirector, isPartner, new Date(Date.UTC(2026, 6, 1, 0, index)).toISOString()]);
  }
  database._runSync(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,0,1,0,0,'member','active',?)
  `, ["sort%literal", "퍼센트회원", "test-hash", "test-salt", "192.0.2.250", new Date(Date.UTC(2026, 6, 2)).toISOString()]);
  database._runSync(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,0,1,0,0,'member','active',?)
  `, ["sort_under", "밑줄회원", "test-hash", "test-salt", "192.0.2.251", new Date(Date.UTC(2026, 6, 2, 0, 1)).toISOString()]);
  database._runSync(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,is_director,is_partner,role,status,created_at)
    VALUES(?,?,?,?,?,0,1,0,0,'member','active',?)
  `, ["sort!bang", "느낌표회원", "test-hash", "test-salt", "192.0.2.252", new Date(Date.UTC(2026, 6, 2, 0, 2)).toISOString()]);
} finally {
  database.close();
}

const anonymousMembers = await fetch(`${baseUrl}/api/admin/members`);
assert.equal(anonymousMembers.status, 401);

const anonymousEvent = await fetch(`${baseUrl}/api/admin/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ category: "events", title: eventTitle, body: "비로그인 등록은 차단되어야 합니다." }),
});
assert.equal(anonymousEvent.status, 401);

const wrongLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: "removed-owner", password: "wrong-password" }),
});
assert.equal(wrongLogin.status, 401);

const login = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(cookie, /^cn_admin_session=/);

const memberList = async (parameters = {}) => {
  const search = new URLSearchParams(parameters);
  const response = await fetch(`${baseUrl}/api/admin/members?${search}`, { headers: { Cookie: cookie } });
  return { response, data: await response.json() };
};
const directorList = async (parameters = {}) => {
  const search = new URLSearchParams(parameters);
  const response = await fetch(`${baseUrl}/api/admin/director-regions?${search}`, { headers: { Cookie: cookie } });
  return { response, data: await response.json() };
};
const patchMembers = async (members) => {
  const response = await fetch(`${baseUrl}/api/admin/members`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ members }),
  });
  return { response, data: await response.json() };
};
const memberUpdate = (member, changes = {}) => ({
  id: member.id,
  nickname: member.nickname,
  points: member.points,
  level: member.level,
  levelLocked: member.levelLocked,
  status: member.status,
  isDirector: member.isDirector,
  isPartner: member.isPartner,
  ...changes,
});
const assertOrdered = (rows, key, direction) => {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const comparison = previous[key] === current[key]
      ? direction * (previous.id - current.id)
      : direction * (previous[key] > current[key] ? 1 : -1);
    assert.ok(comparison >= 0, `${key} ${direction > 0 ? "내림차순" : "오름차순"} 정렬이 안정적이어야 합니다.`);
  }
};
const assertTextOrdered = (rows, key, direction) => {
  const collator = new Intl.Collator("en", { sensitivity: "base" });
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1];
    const current = rows[index];
    const primary = collator.compare(previous[key], current[key]);
    const comparison = primary === 0 ? direction * (previous.id - current.id) : direction * primary;
    assert.ok(comparison >= 0, `${key} text ordering should be stable`);
  }
};
const assertFlagFirst = (rows, key) => {
  const firstFalse = rows.findIndex((row) => !row[key]);
  if (firstFalse < 0) return;
  assert.equal(rows.slice(firstFalse).some((row) => row[key]), false, `${key} rows must not appear after regular members`);
};

assert.equal((await memberList({ sort: "unknown" })).response.status, 400);
assert.equal((await memberList({ sort: "__proto__" })).response.status, 400);
assert.equal((await memberList({ page: "0" })).response.status, 400);
for (const pageSize of ["1", "50", "999", "1001", "abc"]) {
  assert.equal((await memberList({ pageSize })).response.status, 400);
  assert.equal((await directorList({ pageSize })).response.status, 400);
}
const nullMemberPayload = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: "null",
});
assert.equal(nullMemberPayload.status, 400);
const malformedMemberPayload = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: "{",
});
assert.equal(malformedMemberPayload.status, 400);
const invalidNicknamePayload = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ members: [{ id: 1, nickname: 7 }] }),
});
assert.equal(invalidNicknamePayload.status, 400);
assert.equal((await memberList({ q: "가".repeat(17) })).response.status, 400);
assert.equal((await memberList({ q: "%".repeat(25) })).response.status, 400);
assert.equal((await memberList({ q: "가".repeat(16) })).response.status, 200);

const pointsDesc = (await memberList({ q: "sort-user-", sort: "points_desc", pageSize: "100" })).data;
assert.equal(pointsDesc.total, 205);
assertOrdered(pointsDesc.members, "points", 1);
const pointsAsc = (await memberList({ q: "sort-user-", sort: "points_asc", pageSize: "100" })).data;
assertOrdered(pointsAsc.members, "points", -1);
const levelDesc = (await memberList({ q: "sort-user-", sort: "level_desc", pageSize: "100" })).data;
assertOrdered(levelDesc.members, "level", 1);
const levelAsc = (await memberList({ q: "sort-user-", sort: "level_asc", pageSize: "100" })).data;
assertOrdered(levelAsc.members, "level", -1);

const usernameAsc = (await memberList({ q: "sort-user-", sort: "username_asc" })).data;
assert.equal(usernameAsc.members[0].username, "sort-user-000");
assertTextOrdered(usernameAsc.members, "username", -1);
const usernameDesc = (await memberList({ q: "sort-user-", sort: "username_desc" })).data;
assert.equal(usernameDesc.members[0].username, "sort-user-204");
assertTextOrdered(usernameDesc.members, "username", 1);
const nicknameAsc = (await memberList({ q: "정렬회원", sort: "nickname_asc" })).data;
assert.equal(nicknameAsc.members[0].nickname, "정렬회원000");
assertTextOrdered(nicknameAsc.members, "nickname", -1);
const nicknameDesc = (await memberList({ q: "정렬회원", sort: "nickname_desc" })).data;
assert.equal(nicknameDesc.members[0].nickname, "정렬회원204");
assertTextOrdered(nicknameDesc.members, "nickname", 1);

const createdDesc = (await memberList({ q: "sort-user-", sort: "created_desc", pageSize: "100" })).data;
assertOrdered(createdDesc.members, "createdAt", 1);
const createdAsc = (await memberList({ q: "sort-user-", sort: "created_asc", pageSize: "100" })).data;
assertOrdered(createdAsc.members, "createdAt", -1);
const directorFirst = (await memberList({ q: "sort-user-", sort: "director_first", pageSize: "100" })).data;
assert.equal(directorFirst.members[0].isDirector, true);
assertFlagFirst(directorFirst.members, "isDirector");
const partnerFirst = (await memberList({ q: "sort-user-", sort: "partner_first", pageSize: "100" })).data;
assert.equal(partnerFirst.members[0].isPartner, true);
assert.equal(typeof partnerFirst.members[0].isDirector, "boolean");
assertFlagFirst(partnerFirst.members, "isPartner");

const pageOne = (await memberList({ q: "sort-user-", sort: "created_desc", page: "1" })).data;
const pageTwo = (await memberList({ q: "sort-user-", sort: "created_desc", page: "2" })).data;
assert.equal(pageOne.pageSize, 10);
assert.equal(pageOne.members.length, 10);
assert.equal(pageTwo.members.length, 10);
assert.equal(pageOne.members.some((member) => pageTwo.members.some((next) => next.id === member.id)), false);
const lastPage = (await memberList({ q: "sort-user-", sort: "created_desc", page: "999" })).data;
assert.equal(lastPage.page, 21);
assert.equal(lastPage.members.length, 5);
const hundredMemberPage = (await memberList({ q: "sort-user-", sort: "created_desc", pageSize: "100" })).data;
assert.equal(hundredMemberPage.pageSize, 100);
assert.equal(hundredMemberPage.members.length, 100);
const thousandMemberPage = (await memberList({ q: "sort-user-", sort: "created_desc", pageSize: "1000" })).data;
assert.equal(thousandMemberPage.pageSize, 1000);
assert.equal(thousandMemberPage.members.length, 205);

const defaultDirectors = await directorList();
assert.equal(defaultDirectors.response.status, 200, JSON.stringify(defaultDirectors.data));
assert.equal(defaultDirectors.data.pageSize, 10);
assert.equal(defaultDirectors.data.total, 7);
assert.equal(defaultDirectors.data.directors.length, 7);
assert.equal(Object.hasOwn(defaultDirectors.data, "assignments"), false, "paged director list must not include every region assignment");
assert.ok(defaultDirectors.data.directors.every((director) => Number.isInteger(director.assignmentCount)));
const firstDirectorAssignments = await directorList({ userId: String(defaultDirectors.data.directors[0].id) });
assert.equal(firstDirectorAssignments.response.status, 200, JSON.stringify(firstDirectorAssignments.data));
assert.equal(firstDirectorAssignments.data.userId, defaultDirectors.data.directors[0].id);
assert.equal(firstDirectorAssignments.data.assignments.length, defaultDirectors.data.directors[0].assignmentCount);
assert.ok(firstDirectorAssignments.data.assignments.every((assignment) => assignment.userId === firstDirectorAssignments.data.userId));
assert.equal((await directorList({ userId: "0" })).response.status, 400);
assert.equal((await directorList({ userId: "" })).response.status, 400);
assert.equal((await directorList({ userId: "999999" })).response.status, 404);
for (const body of ["{", "null", "[]"]) {
  const response = await fetch(`${baseUrl}/api/admin/director-regions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body,
  });
  assert.equal(response.status, 400, `director payload ${body} must be rejected as client input`);
}
for (const payload of [
  { userId: String(firstDirectorAssignments.data.userId), regions: [] },
  { userId: firstDirectorAssignments.data.userId, regions: [null] },
]) {
  const response = await fetch(`${baseUrl}/api/admin/director-regions`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify(payload),
  });
  assert.equal(response.status, 400, JSON.stringify(payload));
}
const hundredDirectors = (await directorList({ pageSize: "100" })).data;
assert.equal(hundredDirectors.pageSize, 100);
assert.equal(hundredDirectors.directors.length, 7);
const thousandDirectors = (await directorList({ pageSize: "1000", page: "999" })).data;
assert.equal(thousandDirectors.pageSize, 1000);
assert.equal(thousandDirectors.page, 1);
assert.equal(thousandDirectors.directors.length, 7);

const escapedPercent = (await memberList({ q: "sort%" })).data;
assert.equal(escapedPercent.total, 1);
assert.equal(escapedPercent.members[0].username, "sort%literal");
const escapedUnderscore = (await memberList({ q: "sort_" })).data;
assert.equal(escapedUnderscore.total, 1);
assert.equal(escapedUnderscore.members[0].username, "sort_under");
const escapedBang = (await memberList({ q: "sort!" })).data;
assert.equal(escapedBang.total, 1);
assert.equal(escapedBang.members[0].username, "sort!bang");
const caseInsensitive = (await memberList({ q: "SORT-USER-010" })).data;
assert.equal(caseInsensitive.total, 1);
assert.equal(caseInsensitive.members[0].username, "sort-user-010");
const injection = (await memberList({ q: "' OR 1=1 --" })).data;
assert.equal(injection.total, 0);
const noSubstringFallback = (await memberList({ q: "user-010" })).data;
assert.equal(noSubstringFallback.total, 0);

const firstBatchTarget = pageOne.members[0];
const secondBatchTarget = pageOne.members[1];
const invalidPartnerRole = await patchMembers([{ id: firstBatchTarget.id, isPartner: true, isDirector: false }]);
assert.equal(invalidPartnerRole.response.status, 409);
assert.match(invalidPartnerRole.data.error, /실장/);
const validBatch = await patchMembers([
  memberUpdate(firstBatchTarget, { points: firstBatchTarget.points + 3 }),
  memberUpdate(secondBatchTarget, { points: secondBatchTarget.points + 5 }),
]);
assert.equal(validBatch.response.status, 200, JSON.stringify(validBatch.data));
assert.equal(validBatch.data.updated, 2);
const firstAfterValidBatch = (await memberList({ q: firstBatchTarget.username })).data.members[0];
const secondAfterValidBatch = (await memberList({ q: secondBatchTarget.username })).data.members[0];
assert.equal(firstAfterValidBatch.points, firstBatchTarget.points + 3);
assert.equal(secondAfterValidBatch.points, secondBatchTarget.points + 5);

const sparsePoints = firstAfterValidBatch.points + 11;
const sparseNickname = `희소회원${firstAfterValidBatch.id}`.slice(0, 12);
assert.equal((await patchMembers([{ id: firstAfterValidBatch.id, points: sparsePoints }])).response.status, 200);
assert.equal((await patchMembers([{ id: firstAfterValidBatch.id, nickname: sparseNickname }])).response.status, 200);
const firstAfterSparseUpdates = (await memberList({ q: firstBatchTarget.username })).data.members[0];
assert.equal(firstAfterSparseUpdates.points, sparsePoints, "nickname-only stale edits must not overwrite a newer points value");
assert.equal(firstAfterSparseUpdates.nickname, sparseNickname);
assert.equal(firstAfterSparseUpdates.level, firstAfterValidBatch.level);
assert.equal(firstAfterSparseUpdates.status, firstAfterValidBatch.status);

const lockWithoutLevelChange = await patchMembers([{ id: firstAfterSparseUpdates.id, levelLocked: true }]);
assert.equal(lockWithoutLevelChange.response.status, 200, JSON.stringify(lockWithoutLevelChange.data));
const lockedAtSameLevel = (await memberList({ q: firstBatchTarget.username })).data.members[0];
assert.equal(lockedAtSameLevel.level, firstAfterSparseUpdates.level);
assert.equal(lockedAtSameLevel.levelLocked, true, "관리자는 현재 레벨을 바꾸지 않고도 자동 레벨업을 고정할 수 있어야 합니다.");
assert.equal((await patchMembers([{ id: lockedAtSameLevel.id, levelLocked: false }])).response.status, 200);
const unlockedAtSameLevel = (await memberList({ q: firstBatchTarget.username })).data.members[0];
assert.equal(unlockedAtSameLevel.levelLocked, false, "명시적 고정 해제로 자동 레벨업을 다시 활성화해야 합니다.");
const manuallySelectedLevel = unlockedAtSameLevel.level === 9 ? 8 : unlockedAtSameLevel.level + 1;
assert.equal((await patchMembers([{ id: unlockedAtSameLevel.id, level: manuallySelectedLevel }])).response.status, 200);
const manuallyLocked = (await memberList({ q: firstBatchTarget.username })).data.members[0];
assert.equal(manuallyLocked.level, manuallySelectedLevel);
assert.equal(manuallyLocked.levelLocked, true, "관리자가 레벨을 직접 변경하면 기본적으로 고정되어야 합니다.");

const duplicateBatch = await patchMembers([
  { id: firstAfterSparseUpdates.id, points: firstAfterSparseUpdates.points },
  { id: firstAfterSparseUpdates.id, points: firstAfterSparseUpdates.points },
]);
assert.equal(duplicateBatch.response.status, 400);

const atomicFailure = await patchMembers([
  { id: firstAfterSparseUpdates.id, points: firstAfterSparseUpdates.points + 777 },
  { id: secondAfterValidBatch.id, nickname: firstAfterSparseUpdates.nickname },
]);
assert.equal(atomicFailure.response.status, 409, JSON.stringify(atomicFailure.data));
const firstAfterFailure = (await memberList({ q: firstBatchTarget.username })).data.members[0];
const secondAfterFailure = (await memberList({ q: secondBatchTarget.username })).data.members[0];
assert.equal(firstAfterFailure.points, firstAfterSparseUpdates.points, "failed batch must roll back earlier updates");
assert.equal(secondAfterFailure.nickname, secondAfterValidBatch.nickname, "failed batch must roll back every member update");

const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: cookie } });
assert.equal(overview.status, 200);
const overviewData = await overview.json();
assert.equal(Object.hasOwn(overviewData, "members"), false, "overview must not duplicate the paginated member directory");
assert.equal(overviewData.health.status, "healthy");
assert.equal(overviewData.health.database, "ok");
assert.equal(overviewData.health.migrations, "ready");
assert.ok(Array.isArray(overviewData.posts));
assert.ok(Array.isArray(overviewData.blockedIps));

const anonymousHealth = await fetch(`${baseUrl}/api/admin/health`);
assert.equal(anonymousHealth.status, 401);
const authenticatedHealth = await fetch(`${baseUrl}/api/admin/health`, { headers: { Cookie: cookie } });
assert.equal(authenticatedHealth.status, 200);
assert.match(authenticatedHealth.headers.get("cache-control") ?? "", /private/);
assert.equal((await authenticatedHealth.json()).health.status, "healthy");

const createEvent = await fetch(`${baseUrl}/api/admin/events`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ category: "events", title: eventTitle, authorName: "이벤트운영팀", body: "관리자 페이지에서 작성한 이벤트 상세 내용입니다." }),
});
assert.equal(createEvent.status, 201, JSON.stringify(await createEvent.clone().json()));
const createdEvent = await createEvent.json();
assert.equal(createdEvent.post.author, "이벤트운영팀");
assert.equal(createdEvent.post.category, "events");

const eventBoard = await fetch(`${baseUrl}/api/posts?category=events`);
assert.equal(eventBoard.status, 200);
const eventBoardData = await eventBoard.json();
assert.ok(eventBoardData.posts.some((post) => post.id === createdEvent.post.id && post.title === eventTitle && post.author === "이벤트운영팀"));

const noticeTitle = `독립 공지 ${Date.now().toString(36)}`;
const createNotice = await fetch(`${baseUrl}/api/admin/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ category: "notices", title: noticeTitle, authorName: "공지운영팀", body: "공지사항 대메뉴에 게시되는 관리자 공지입니다." }),
});
assert.equal(createNotice.status, 201, JSON.stringify(await createNotice.clone().json()));
const noticeData = await createNotice.json();
assert.equal(noticeData.post.isNotice, true);
const noticeBoard = await fetch(`${baseUrl}/api/posts?category=notices`);
assert.equal(noticeBoard.status, 200);
const noticeBoardData = await noticeBoard.json();
assert.equal(noticeBoardData.posts[0].id, noticeData.post.id);
assert.equal(noticeBoardData.posts[0].isNotice, 1);
assert.equal(noticeBoardData.posts[0].author, "공지운영팀");

for (const removedNoticeCategory of ["reviews", "gifs", "community"]) {
  const removedNotice = await fetch(`${baseUrl}/api/admin/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ category: removedNoticeCategory, title: "기존 게시판 공지 차단", body: "독립 공지사항 외에는 관리자 공지를 만들 수 없습니다." }),
  });
  assert.equal(removedNotice.status, 400);
}

const refreshedOverview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: cookie } });
assert.equal(refreshedOverview.status, 200);
assert.ok((await refreshedOverview.json()).posts.some((post) => post.id === createdEvent.post.id && post.author === "이벤트운영팀"));

const block = await fetch(`${baseUrl}/api/admin/blocked-ips`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ ip: testIp, reason: "통합 테스트" }),
});
assert.equal(block.status, 200);

const unblock = await fetch(`${baseUrl}/api/admin/blocked-ips`, {
  method: "DELETE",
  headers: { "Content-Type": "application/json", Cookie: cookie },
  body: JSON.stringify({ ip: testIp }),
});
assert.equal(unblock.status, 200);

const logout = await fetch(`${baseUrl}/api/admin/logout`, { method: "POST", headers: { Cookie: cookie } });
assert.equal(logout.status, 200);

console.log("관리자 검증 통과: 이벤트·독립 공지사항 등록, 기존 게시판 공지 차단, 실제 데이터 조회, IP 차단·해제, 로그아웃");
