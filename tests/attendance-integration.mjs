import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const unique = Date.now().toString(36);
const ip = `203.0.113.${20 + (Date.now() % 180)}`;
const greeting = `역시 하루의 시작은 출장나라 ${unique}`.slice(0, 50);

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

const anonymousSummary = await json(await fetch(`${baseUrl}/api/attendance`));
assert.equal(anonymousSummary.response.status, 200);
assert.equal(anonymousSummary.body.user, null);
assert.deepEqual(anonymousSummary.body.calendar, []);
assert.deepEqual(anonymousSummary.body.streakRewards.map((reward) => [reward.days, reward.points]), [
  [10, 1000],
  [30, 5000],
  [100, 20000],
  [200, 50000],
  [365, 100000],
  [500, 300000],
]);

const anonymousPost = await json(await fetch(`${baseUrl}/api/attendance`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ greeting }),
}));
assert.equal(anonymousPost.response.status, 401);

const challenge = await captcha();
const username = `att${unique}`.slice(0, 20);
const password = "Attendance!2026";
const registered = await json(await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: challenge.cookie, "X-Forwarded-For": ip },
  body: JSON.stringify({ username, nickname: `출석${unique}`.slice(0, 12), password, passwordConfirm: password, captchaAnswer: challenge.answer }),
}));
assert.equal(registered.response.status, 201);

const loggedIn = await json(await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
  body: JSON.stringify({ username, password }),
}));
assert.equal(loggedIn.response.status, 200);
assert.equal(loggedIn.body.user.points, 0);
assert.equal(loggedIn.body.user.attended, false);
const sessionCookie = loggedIn.response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(sessionCookie, /^cn_session=/);

const checkedIn = await json(await fetch(`${baseUrl}/api/attendance`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ greeting }),
}));
assert.equal(checkedIn.response.status, 200);
assert.equal(checkedIn.body.points, 50);
assert.equal(checkedIn.body.currentStreak, 1);
assert.equal(checkedIn.body.rewardBonusPoints, 0);

const summary = await json(await fetch(`${baseUrl}/api/attendance`, { headers: { Cookie: sessionCookie } }));
assert.equal(summary.response.status, 200);
assert.equal(summary.body.user.points, 50);
assert.equal(summary.body.user.attended, true);
assert.ok(summary.body.entries.some((entry) => entry.greeting === greeting));
assert.ok(summary.body.calendar.some((entry) => entry.date === summary.body.today && entry.points === 50));

const duplicate = await json(await fetch(`${baseUrl}/api/attendance`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: sessionCookie },
  body: JSON.stringify({ greeting: "두 번째 출석 시도" }),
}));
assert.equal(duplicate.response.status, 409);

console.log("출석 검증 통과: 비로그인 달력 비공개, 로그인, 달력 50P 표시, 인사 게시판 저장, 하루 1회 제한");
