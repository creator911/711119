import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const unique = Date.now().toString(36);
const ip = `198.51.100.${20 + (Date.now() % 180)}`;

async function getCaptcha() {
  const response = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^image\/svg\+xml/);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  assert.match(cookie, /^cn_captcha=/);
  const svg = await response.text();
  const answer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
  assert.match(answer, /^\d{5}$/);
  return { answer, cookie };
}

async function register(payload, cookie) {
  return fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, "X-Forwarded-For": ip },
    body: JSON.stringify(payload),
  });
}

const basePayload = {
  username: `test${unique}`.slice(0, 20),
  nickname: `테스트${unique}`.slice(0, 12),
  password: "SafePass!2026",
  passwordConfirm: "SafePass!2026",
};

{
  const captcha = await getCaptcha();
  const response = await register({ ...basePayload, passwordConfirm: "Mismatch!2026", captchaAnswer: captcha.answer }, captcha.cookie);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /비밀번호 확인/);
}

{
  const captcha = await getCaptcha();
  const response = await register({ ...basePayload, captchaAnswer: captcha.answer === "00000" ? "11111" : "00000" }, captcha.cookie);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /자동 등록 방지/);
}

{
  const captcha = await getCaptcha();
  const response = await register({ ...basePayload, captchaAnswer: captcha.answer }, captcha.cookie);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).ok, true);
}

{
  const captcha = await getCaptcha();
  const response = await register({
    ...basePayload,
    username: `again${unique}`.slice(0, 20),
    nickname: `재가입${unique}`.slice(0, 12),
    captchaAnswer: captcha.answer,
  }, captcha.cookie);
  const result = await response.json();
  assert.equal(response.status, 201, JSON.stringify(result));
  assert.equal(result.ok, true);
}

console.log("회원가입 검증 통과: 비밀번호 불일치, 자동등록방지 실패, 정상 가입, 동일 IP 재가입 허용");
