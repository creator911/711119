import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;
if (!adminUsername || !adminPassword) throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
const unique = Date.now().toString(36);
const username = `help${unique}`.slice(0, 20);
const nickname = `문의${unique}`.slice(0, 12);
const password = "SafePass!2026";
const ip = `203.0.113.${20 + (Date.now() % 180)}`;
const imageBytes = Buffer.from("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==", "base64");

async function uploadImage(cookie, extraHeaders = {}) {
  const form = new FormData();
  form.append("file", new Blob([imageBytes], { type: "image/gif" }), `support-${unique}.gif`);
  const response = await fetch(`${baseUrl}/api/uploads`, {
    method: "POST",
    headers: { Cookie: cookie, ...extraHeaders },
    body: form,
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
  const result = await response.json();
  assert.match(result.url, /^\/api\/media\/[0-9a-f-]{36}\.gif$/);
  return result.url;
}

async function createMember(suffix, forwardedIp) {
  const captchaResponse = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}-${suffix}`);
  const captchaCookie = captchaResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const captchaSvg = await captchaResponse.text();
  const captchaAnswer = [...captchaSvg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
  const otherUsername = `other${suffix}`.slice(0, 20);
  const register = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: captchaCookie, "X-Forwarded-For": forwardedIp },
    body: JSON.stringify({ username: otherUsername, nickname: `타인${suffix}`.slice(0, 12), password, passwordConfirm: password, captchaAnswer }),
  });
  assert.equal(register.status, 201, JSON.stringify(await register.clone().json()));
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": forwardedIp },
    body: JSON.stringify({ username: otherUsername, password }),
  });
  assert.equal(login.status, 200);
  return login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

const anonymous = await fetch(`${baseUrl}/api/support`);
assert.equal(anonymous.status, 200);
const anonymousData = await anonymous.json();
assert.equal(anonymousData.user, null);
assert.deepEqual(anonymousData.inquiries, []);

const anonymousPost = await fetch(`${baseUrl}/api/support`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: "비회원 문의", body: "비회원 작성 차단" }),
});
assert.equal(anonymousPost.status, 401);

const captchaResponse = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
assert.equal(captchaResponse.status, 200);
const captchaCookie = captchaResponse.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
const svg = await captchaResponse.text();
const captchaAnswer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
assert.match(captchaAnswer, /^\d{5}$/);

const register = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: captchaCookie, "X-Forwarded-For": ip },
  body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer }),
});
assert.equal(register.status, 201, JSON.stringify(await register.clone().json()));

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200);
const memberCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(memberCookie, /^cn_session=/);

const title = `1:1 문의 테스트 ${unique}`;
const body = `고객센터 게시판형 문의 내용입니다. ${unique}`;
const createInquiry = await fetch(`${baseUrl}/api/support`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ title, body }),
});
assert.equal(createInquiry.status, 201, JSON.stringify(await createInquiry.clone().json()));
const created = (await createInquiry.json()).inquiry;
assert.equal(created.title, title);
assert.equal(created.body, body);
assert.equal(created.status, "open");

const memberListResponse = await fetch(`${baseUrl}/api/support`, { headers: { Cookie: memberCookie } });
assert.equal(memberListResponse.status, 200);
const memberList = await memberListResponse.json();
assert.ok(memberList.inquiries.some((item) => item.id === created.id && item.title === title));

const memberDetailResponse = await fetch(`${baseUrl}/api/support/${created.id}`, { headers: { Cookie: memberCookie } });
assert.equal(memberDetailResponse.status, 200);
const memberDetail = await memberDetailResponse.json();
assert.equal(memberDetail.inquiry.body, body);
assert.deepEqual(memberDetail.replies, []);

const memberReplyText = `추가 문의입니다 ${unique}`;
const memberReply = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ body: memberReplyText }),
});
assert.equal(memberReply.status, 201);
assert.equal((await memberReply.json()).senderType, "member");

const memberImagePublicUrl = await uploadImage(memberCookie);
const memberImageProtectedUrl = memberImagePublicUrl.replace("/api/media/", "/api/support/media/");
const memberImageReply = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ body: `<p>회원 첨부 이미지</p><p class="editor-media-block"><img src="${memberImageProtectedUrl}" alt="첨부 이미지" /></p>` }),
});
assert.equal(memberImageReply.status, 201, JSON.stringify(await memberImageReply.clone().json()));
assert.match((await memberImageReply.json()).body, /\/api\/support\/media\//);
assert.equal((await fetch(`${baseUrl}${memberImageProtectedUrl}`, { headers: { Cookie: memberCookie } })).status, 200);
assert.equal((await fetch(`${baseUrl}${memberImageProtectedUrl}`)).status, 404);
assert.equal((await fetch(`${baseUrl}${memberImagePublicUrl}`, { headers: { Cookie: memberCookie } })).status, 404);
const otherMemberCookie = await createMember(`${unique}x`, `198.51.100.${20 + (Date.now() % 180)}`);
assert.equal((await fetch(`${baseUrl}${memberImageProtectedUrl}`, { headers: { Cookie: otherMemberCookie } })).status, 404);

const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(adminLogin.status, 200);
const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";

const adminListResponse = await fetch(`${baseUrl}/api/admin/support`, { headers: { Cookie: adminCookie } });
assert.equal(adminListResponse.status, 200);
const inquiries = (await adminListResponse.json()).inquiries;
const adminInquiry = inquiries.find((item) => item.id === created.id && item.username === username);
assert.ok(adminInquiry);
assert.equal(adminInquiry.title, title);
assert.equal(adminInquiry.staffUnread, 3);

const adminDetailResponse = await fetch(`${baseUrl}/api/admin/support/${created.id}`, { headers: { Cookie: adminCookie } });
assert.equal(adminDetailResponse.status, 200);
const adminDetail = await adminDetailResponse.json();
assert.equal(adminDetail.inquiry.title, title);
assert.ok(adminDetail.replies.some((reply) => reply.body === memberReplyText));

const adminImagePublicUrl = await uploadImage(`${memberCookie}; ${adminCookie}`, { "X-Upload-Context": "admin" });
const adminImageProtectedUrl = adminImagePublicUrl.replace("/api/media/", "/api/support/media/");
const adminImageReply = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ body: `<p>관리자 첨부 이미지</p><p class="editor-media-block"><img src="${adminImageProtectedUrl}" alt="첨부 이미지" /></p>` }),
});
assert.equal(adminImageReply.status, 201, JSON.stringify(await adminImageReply.clone().json()));
assert.equal((await fetch(`${baseUrl}${adminImageProtectedUrl}`, { headers: { Cookie: memberCookie } })).status, 200);
assert.equal((await fetch(`${baseUrl}${adminImageProtectedUrl}`, { headers: { Cookie: adminCookie } })).status, 200);
assert.equal((await fetch(`${baseUrl}${adminImagePublicUrl}`)).status, 404);

const staffText = `답변 확인했습니다 ${unique}`;
const staffReply = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ body: staffText }),
});
assert.equal(staffReply.status, 201);
assert.equal((await staffReply.json()).senderType, "staff");

const memberReload = await fetch(`${baseUrl}/api/support/${created.id}`, { headers: { Cookie: memberCookie } });
assert.equal(memberReload.status, 200);
const memberReloadData = await memberReload.json();
assert.equal(memberReloadData.inquiry.status, "answered");
assert.ok(memberReloadData.replies.some((reply) => reply.senderType === "staff" && reply.body === staffText));

const close = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ status: "closed" }),
});
assert.equal(close.status, 200);
assert.equal((await close.json()).status, "closed");

console.log("고객센터 검증 통과: 회원·관리자 사진 답글, 소유자 권한 격리, 공개 경로 차단, 일반 답변·종료");
