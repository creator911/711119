import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
const testIp = `198.51.100.${40 + (Date.now() % 180)}`;
const eventTitle = `관리자 이벤트 ${Date.now().toString(36)}`;

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

const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: cookie } });
assert.equal(overview.status, 200);
const overviewData = await overview.json();
assert.ok(Array.isArray(overviewData.members));
assert.ok(Array.isArray(overviewData.posts));
assert.ok(Array.isArray(overviewData.blockedIps));

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
