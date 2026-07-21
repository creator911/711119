import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const authRoutes = [
  "app/api/auth/register/route.ts",
  "app/api/auth/login/route.ts",
];

test("PBKDF2 설정이 배포 환경 제한을 넘지 않는다", async () => {
  for (const route of authRoutes) {
    const source = await readFile(route, "utf8");
    const match = source.match(/iterations:\s*([\d_]+)/);
    assert.ok(match, `${route}에서 PBKDF2 반복 횟수를 찾을 수 없습니다.`);
    const iterations = Number(match[1].replaceAll("_", ""));
    assert.ok(iterations <= 100_000, `${route}의 PBKDF2 반복 횟수가 배포 환경 제한을 초과합니다.`);
  }
});

test("인증 API가 내부 오류 원문을 사용자에게 노출하지 않는다", async () => {
  const register = await readFile(authRoutes[0], "utf8");
  const login = await readFile(authRoutes[1], "utf8");
  assert.match(register, /회원가입 처리 중 오류가 발생했습니다/);
  assert.match(login, /로그인 처리 중 오류가 발생했습니다/);
  assert.doesNotMatch(register, /:\s*message\s*}/);
});

test("정지 계정은 비밀번호 검증 뒤 전용 안내로 로그인이 차단된다", async () => {
  const login = await readFile(authRoutes[1], "utf8");
  const passwordCheck = login.indexOf("const passwordMatches = await hashPassword");
  const passwordFailure = login.indexOf("if (!passwordMatches)");
  const suspensionCheck = login.indexOf('if (user.status === "suspended")');

  assert.ok(passwordCheck >= 0, "로그인 비밀번호 검증을 찾을 수 없습니다.");
  assert.ok(passwordFailure > passwordCheck, "비밀번호 불일치 판정 순서가 올바르지 않습니다.");
  assert.ok(suspensionCheck > passwordFailure, "정지 여부는 비밀번호가 일치한 뒤 확인해야 합니다.");
  assert.match(login, /이용이 정지 되셨습니다\./);
  assert.match(login, /user\.status === "suspended"[^\n]+status: 403/);
});

test("정지 여부와 무관하게 기존 아이디 재가입을 명시적으로 차단한다", async () => {
  const register = await readFile(authRoutes[0], "utf8");
  const duplicateLookup = register.indexOf("SELECT id FROM users WHERE username = ? LIMIT 1");
  const insertUser = register.indexOf("INSERT INTO users");

  assert.ok(duplicateLookup >= 0, "기존 아이디 조회를 찾을 수 없습니다.");
  assert.ok(insertUser > duplicateLookup, "기존 아이디를 확인한 뒤 회원을 생성해야 합니다.");
  assert.match(register, /if \(existingUsername\)[^\n]+이미 사용 중인 아이디입니다\.[^\n]+status: 409/);
});
