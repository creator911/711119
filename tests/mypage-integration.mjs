import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const unique = Date.now().toString(36);

async function json(response) {
  const body = await response.json();
  return { response, body };
}

async function captcha() {
  const response = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const svg = await response.text();
  const answer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
  assert.match(answer, /^\d{5}$/);
  return { answer, cookie };
}

const anonymous = await json(await fetch(`${baseUrl}/api/mypage`));
assert.equal(anonymous.response.status, 401);

const challenge = await captcha();
const username = `mypage${unique}`.slice(0, 20);
const nickname = `마이${unique}`.slice(0, 12);
const password = "MyPage!2026";
const registered = await json(await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: challenge.cookie },
  body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer: challenge.answer }),
}));
assert.equal(registered.response.status, 201);

const loggedIn = await json(await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
}));
assert.equal(loggedIn.response.status, 200);
const sessionCookie = loggedIn.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(sessionCookie, /^cn_session=/);

const postTitle = `마이페이지 작성글 ${unique}`;
const createdPost = await json(await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ category: "community", title: postTitle, body: "마이페이지 작성글 목록에 표시되어야 합니다." }),
}));
assert.equal(createdPost.response.status, 201);

const comment = await json(await fetch(`${baseUrl}/api/posts/${createdPost.body.post.id}/comments`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ body: "댓글 수 확인용 댓글입니다." }),
}));
assert.equal(comment.response.status, 201);

const attendance = await json(await fetch(`${baseUrl}/api/attendance`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ greeting: `마이페이지 포인트 확인 ${unique}`.slice(0, 50) }),
}));
assert.equal(attendance.response.status, 200);

const mypage = await json(await fetch(`${baseUrl}/api/mypage`, { headers: { Cookie: sessionCookie } }));
assert.equal(mypage.response.status, 200);
assert.equal(mypage.body.user.nickname, nickname);
assert.equal(mypage.body.user.points, 50);
const listedPost = mypage.body.posts.find((post) => post.id === createdPost.body.post.id);
assert.equal(listedPost.title, postTitle);
assert.equal(listedPost.category, "community");
assert.equal(listedPost.commentCount, 1);
assert.ok(mypage.body.pointHistory.some((item) => item.type === "attendance" && item.amount === 50));

console.log("마이페이지 검증 통과: 로그인 보호, 작성글 목록, 댓글 수, 포인트 내역");
