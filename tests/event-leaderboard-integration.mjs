import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const unique = Date.now().toString(36);
const password = "EventKing!2026";
const username = `king${unique}`.slice(0, 20);
const nickname = `랭킹${unique}`.slice(0, 12);

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

const challenge = await captcha();
const registered = await json(await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: challenge.cookie },
  body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer: challenge.answer }),
}));
assert.equal(registered.response.status, 201, JSON.stringify(registered.body));

const login = await json(await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
}));
assert.equal(login.response.status, 200, JSON.stringify(login.body));
const memberCookie = login.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(memberCookie, /^cn_session=/);

for (let index = 0; index < 4; index += 1) {
  const post = await json(await fetch(`${baseUrl}/api/posts`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ category: "community", communityTags: ["일상"], title: `랭킹 테스트 글 ${unique}-${index}`, body: `이벤트 글쓰기왕 집계 테스트 ${unique}-${index}` }),
  }));
  assert.equal(post.response.status, 201, JSON.stringify(post.body));
  const comment = await json(await fetch(`${baseUrl}/api/posts/${post.body.post.id}/comments`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ body: `댓글왕 집계 테스트 ${unique}-${index}` }),
  }));
  assert.equal(comment.response.status, 201, JSON.stringify(comment.body));
}

const attendance = await fetch(`${baseUrl}/api/attendance`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ greeting: `랭킹 출석 테스트 ${unique}`.slice(0, 50) }),
});
assert.ok([200, 409].includes(attendance.status));

const weekly = await json(await fetch(`${baseUrl}/api/events/leaderboard?period=weekly`, { headers: { Cookie: memberCookie } }));
assert.equal(weekly.response.status, 200, JSON.stringify(weekly.body));
assert.equal(weekly.body.period.type, "weekly");
assert.match(weekly.body.period.startDate, /^\d{4}-\d{2}-\d{2}$/);
assert.equal(weekly.body.posts[0].rewardPoints, 10000);
assert.equal(weekly.body.posts[1].rewardPoints, 5000);
assert.equal(weekly.body.posts[2].rewardPoints, 1000);
assert.deepEqual(weekly.body.rewards.posts, [10000, 5000, 1000]);
assert.deepEqual(weekly.body.rewards.comments, [10000, 5000, 1000]);

const postRank = weekly.body.posts.find((row) => row.nickname === nickname);
assert.ok(postRank, "새 회원의 작성글 수가 주간 글쓰기왕 랭킹에 반영되어야 합니다.");
assert.ok(postRank.count >= 4);

const commentRank = weekly.body.comments.find((row) => row.nickname === nickname);
assert.ok(commentRank, "새 회원의 댓글 수와 출석체크가 주간 댓글왕 랭킹에 반영되어야 합니다.");
assert.ok(commentRank.count >= 5);

const monthly = await json(await fetch(`${baseUrl}/api/events/leaderboard?period=monthly`, { headers: { Cookie: memberCookie } }));
assert.equal(monthly.response.status, 200, JSON.stringify(monthly.body));
assert.equal(monthly.body.period.type, "monthly");
assert.equal(monthly.body.posts[0].rewardPoints, 10000);
assert.equal(monthly.body.posts[1].rewardPoints, 5000);
assert.equal(monthly.body.posts[2].rewardPoints, 1000);
assert.deepEqual(monthly.body.rewards.posts, [10000, 5000, 1000]);
assert.deepEqual(monthly.body.rewards.comments, [10000, 5000, 1000]);

console.log("이벤트 랭킹 검증 통과: 주간·월간 글쓰기왕/댓글왕 집계, 출석체크 댓글 1회 포함, 1만·5천·1천P 보상 표시");
