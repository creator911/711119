import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const databasePath = process.env.TEST_DB_PATH;
assert.ok(databasePath, "TEST_DB_PATH가 지정된 격리 테스트 DB에서만 실행할 수 있습니다.");
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
assert.equal(memberDetail.inquiry.replyCount, 0);
assert.deepEqual(memberDetail.replies, []);

const malformedMemberReply = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: "{",
});
assert.equal(malformedMemberReply.status, 400);

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

const malformedAdminReply = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: "{",
});
assert.equal(malformedAdminReply.status, 400);

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
assert.equal(adminDetail.inquiry.replyCount, 2);
assert.ok(adminDetail.replies.some((reply) => reply.body === memberReplyText));
const adminListBeforeViewedAck = await (await fetch(`${baseUrl}/api/admin/support`, { headers: { Cookie: adminCookie } })).json();
assert.equal(adminListBeforeViewedAck.inquiries.find((item) => item.id === created.id)?.staffUnread, 3, "상세 GET만으로 관리자 미확인 표시가 사라지면 안 됩니다.");
const adminViewedAck = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ viewed: true, viewedThroughReplyId: adminDetail.inquiry.latestReplyId }),
});
assert.equal(adminViewedAck.status, 200);
const adminListAfterViewedAck = await (await fetch(`${baseUrl}/api/admin/support`, { headers: { Cookie: adminCookie } })).json();
assert.equal(adminListAfterViewedAck.inquiries.find((item) => item.id === created.id)?.staffUnread, 0);

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
assert.equal(memberReloadData.inquiry.replyCount, 4);
assert.ok(memberReloadData.replies.some((reply) => reply.senderType === "staff" && reply.body === staffText));
const memberListBeforeViewedAck = await (await fetch(`${baseUrl}/api/support`, { headers: { Cookie: memberCookie } })).json();
assert.equal(memberListBeforeViewedAck.inquiries.find((item) => item.id === created.id)?.memberUnread, 2, "상세 GET만으로 회원 미확인 표시가 사라지면 안 됩니다.");
const memberViewedAck = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ viewed: true, viewedThroughReplyId: memberReloadData.inquiry.latestReplyId }),
});
assert.equal(memberViewedAck.status, 200);
const memberListAfterViewedAck = await (await fetch(`${baseUrl}/api/support`, { headers: { Cookie: memberCookie } })).json();
assert.equal(memberListAfterViewedAck.inquiries.find((item) => item.id === created.id)?.memberUnread, 0);

const raceReply = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ body: `읽음 경합 검증 ${unique}` }),
});
assert.equal(raceReply.status, 201);
const staleViewedAck = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ viewed: true, viewedThroughReplyId: memberReloadData.inquiry.latestReplyId }),
});
assert.equal(staleViewedAck.status, 200);
assert.equal((await staleViewedAck.json()).viewed, false, "상세 조회 뒤 도착한 새 답변까지 읽음 처리하면 안 됩니다.");
const memberListAfterStaleAck = await (await fetch(`${baseUrl}/api/support`, { headers: { Cookie: memberCookie } })).json();
assert.equal(memberListAfterStaleAck.inquiries.find((item) => item.id === created.id)?.memberUnread, 1);
const freshRaceDetail = await (await fetch(`${baseUrl}/api/support/${created.id}`, { headers: { Cookie: memberCookie } })).json();
const freshViewedAck = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ viewed: true, viewedThroughReplyId: freshRaceDetail.inquiry.latestReplyId }),
});
assert.equal(freshViewedAck.status, 200);
assert.equal((await freshViewedAck.json()).viewed, true);

assert.equal((await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: otherMemberCookie },
  body: JSON.stringify({ viewed: true, viewedThroughReplyId: memberReloadData.inquiry.latestReplyId }),
})).status, 404);

const close = await fetch(`${baseUrl}/api/admin/support/${created.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ status: "closed" }),
});
assert.equal(close.status, 200);
assert.equal((await close.json()).status, "closed");

const paginationDatabase = new DatabaseSync(databasePath);
const paginationUser = paginationDatabase.prepare("SELECT id FROM users WHERE username=?").get(username);
assert.ok(paginationUser?.id);
const insertPaginationInquiry = paginationDatabase.prepare(`
  INSERT INTO support_inquiries(user_id,kind,title,body,status,staff_unread,member_unread,created_at,updated_at)
  VALUES(?,'support',?,?,'open',1,0,?,?)
`);
paginationDatabase.exec("BEGIN");
try {
  for (let index = 0; index < 35; index += 1) {
    const createdAt = new Date(Date.now() - (index + 1) * 1000).toISOString();
    const paginationTitle = index === 0 ? `literal%_! 문의 ${unique}` : `페이지 문의 ${unique} ${String(index).padStart(2, "0")}`;
    insertPaginationInquiry.run(paginationUser.id, paginationTitle, `페이지네이션 검증 내용 ${index}`, createdAt, createdAt);
  }
  paginationDatabase.exec("COMMIT");
} catch (error) {
  paginationDatabase.exec("ROLLBACK");
  throw error;
} finally {
  paginationDatabase.close();
}

const memberPageOneResponse = await fetch(`${baseUrl}/api/support?page=1`, { headers: { Cookie: memberCookie } });
assert.equal(memberPageOneResponse.status, 200);
const memberPageOne = await memberPageOneResponse.json();
assert.equal(memberPageOne.total, 36);
assert.equal(memberPageOne.pageSize, 20);
assert.equal(memberPageOne.totalPages, 2);
assert.equal(memberPageOne.inquiries.length, 20);
const memberPageTwoResponse = await fetch(`${baseUrl}/api/support?page=2`, { headers: { Cookie: memberCookie } });
assert.equal(memberPageTwoResponse.status, 200);
const memberPageTwo = await memberPageTwoResponse.json();
assert.equal(memberPageTwo.page, 2);
assert.equal(memberPageTwo.inquiries.length, 16);
assert.ok(memberPageTwo.inquiries.some((item) => item.id === created.id));
assert.equal((await fetch(`${baseUrl}/api/support?page=0`, { headers: { Cookie: memberCookie } })).status, 400);

const adminPageOneResponse = await fetch(`${baseUrl}/api/admin/support?page=1&pageSize=30`, { headers: { Cookie: adminCookie } });
assert.equal(adminPageOneResponse.status, 200);
const adminPageOne = await adminPageOneResponse.json();
assert.equal(adminPageOne.total, 36);
assert.equal(adminPageOne.pageSize, 30);
assert.equal(adminPageOne.totalPages, 2);
assert.equal(adminPageOne.inquiries.length, 30);
const adminPageTwoResponse = await fetch(`${baseUrl}/api/admin/support?page=2&pageSize=30`, { headers: { Cookie: adminCookie } });
assert.equal(adminPageTwoResponse.status, 200);
const adminPageTwo = await adminPageTwoResponse.json();
assert.equal(adminPageTwo.inquiries.length, 6);
assert.ok(adminPageTwo.inquiries.some((item) => item.id === created.id));
const adminSearchResponse = await fetch(`${baseUrl}/api/admin/support?q=${encodeURIComponent(`페이지 문의 ${unique} 34`)}`, { headers: { Cookie: adminCookie } });
assert.equal(adminSearchResponse.status, 200);
const adminSearch = await adminSearchResponse.json();
assert.equal(adminSearch.total, 1);
assert.equal(adminSearch.inquiries[0]?.title, `페이지 문의 ${unique} 34`);
assert.equal(Object.hasOwn(adminSearch, "searchScope"), false);
for (const [prefix, minimum] of [[username.toUpperCase(), 36], [nickname, 36], ["literal%_!", 1]]) {
  const response = await fetch(`${baseUrl}/api/admin/support?q=${encodeURIComponent(prefix)}`, { headers: { Cookie: adminCookie } });
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.ok(result.total >= minimum, `${prefix} 앞부분 검색이 전체 문의에서 누락되면 안 됩니다.`);
}
assert.equal((await fetch(`${baseUrl}/api/admin/support?pageSize=101`, { headers: { Cookie: adminCookie } })).status, 400);
assert.equal((await fetch(`${baseUrl}/api/admin/support?q=${encodeURIComponent("가".repeat(27))}`, { headers: { Cookie: adminCookie } })).status, 400);
assert.equal((await fetch(`${baseUrl}/api/admin/support?q=${encodeURIComponent("a".repeat(80))}`, { headers: { Cookie: adminCookie } })).status, 200);

for (let index = 0; index < 4; index += 1) {
  const response = await fetch(`${baseUrl}/api/support`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ title: `요청 제한 문의 ${index}`, body: `요청 제한 정상 범위 ${index}` }),
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
}
const inquiryRateLimited = await fetch(`${baseUrl}/api/support`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ title: "요청 제한 초과 문의", body: "요청 제한 초과 확인" }),
});
assert.equal(inquiryRateLimited.status, 429);
assert.match(inquiryRateLimited.headers.get("retry-after") ?? "", /^\d+$/);
const otherMemberInquiry = await fetch(`${baseUrl}/api/support`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: otherMemberCookie },
  body: JSON.stringify({ title: "다른 회원 문의", body: "회원별 요청 제한 분리" }),
});
assert.equal(otherMemberInquiry.status, 201);

for (let index = 0; index < 18; index += 1) {
  const response = await fetch(`${baseUrl}/api/support/${created.id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: memberCookie },
    body: JSON.stringify({ body: `요청 제한 답글 ${index}` }),
  });
  assert.equal(response.status, 201, JSON.stringify(await response.clone().json()));
}
const replyRateLimited = await fetch(`${baseUrl}/api/support/${created.id}`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ body: "요청 제한 초과 답글" }),
});
assert.equal(replyRateLimited.status, 429);
assert.match(replyRateLimited.headers.get("retry-after") ?? "", /^\d+$/);

const cursorDatabase = new DatabaseSync(databasePath);
const cursorReplyIds = [];
let cursorInquiryId = 0;
try {
  const cursorUser = cursorDatabase.prepare("SELECT id FROM users WHERE username=?").get(username);
  assert.ok(cursorUser?.id);
  const cursorCreatedAt = new Date().toISOString();
  const cursorInquiry = cursorDatabase.prepare(`
    INSERT INTO support_inquiries(user_id,kind,title,body,status,staff_unread,member_unread,created_at,updated_at)
    VALUES(?,'support',?,?,'open',0,0,?,?)
  `).run(cursorUser.id, `커서 문의 ${unique}`, "1,001개 답변 커서 검증", cursorCreatedAt, cursorCreatedAt);
  cursorInquiryId = Number(cursorInquiry.lastInsertRowid);
  const insertCursorReply = cursorDatabase.prepare(`
    INSERT INTO support_inquiry_replies(inquiry_id,sender_type,sender_id,body,created_at)
    VALUES(?,?,?,?,?)
  `);
  cursorDatabase.exec("BEGIN");
  try {
    for (let index = 0; index < 1_001; index += 1) {
      const senderType = index % 2 === 0 ? "member" : "staff";
      const inserted = insertCursorReply.run(cursorInquiryId, senderType, String(cursorUser.id), `커서 답변 ${index}`, new Date(Date.now() + index).toISOString());
      cursorReplyIds.push(Number(inserted.lastInsertRowid));
    }
    cursorDatabase.exec("COMMIT");
  } catch (error) {
    cursorDatabase.exec("ROLLBACK");
    throw error;
  }
} finally {
  cursorDatabase.close();
}

async function collectCursorReplies(pathPrefix, cookie, label) {
  let beforeReplyId = null;
  let collected = [];
  const pageSizes = [];
  for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
    const search = new URLSearchParams({ kind: "support" });
    if (beforeReplyId !== null) search.set("beforeReplyId", String(beforeReplyId));
    const response = await fetch(`${baseUrl}${pathPrefix}/${cursorInquiryId}?${search.toString()}`, { headers: { Cookie: cookie } });
    assert.equal(response.status, 200, `${label} cursor page ${pageIndex + 1}`);
    const result = await response.json();
    assert.equal(result.inquiry.replyCount, 1_001);
    const ids = result.replies.map((reply) => Number(reply.id));
    assert.deepEqual(ids, [...ids].sort((left, right) => left - right), `${label} page order`);
    assert.equal(new Set(ids).size, ids.length, `${label} page duplicates`);
    pageSizes.push(ids.length);
    collected = [...ids, ...collected];
    beforeReplyId = result.previousReplyCursor ?? null;
    if (pageIndex < 2) assert.ok(Number.isSafeInteger(beforeReplyId) && beforeReplyId > 0, `${label} next cursor`);
  }
  assert.deepEqual(pageSizes, [500, 500, 1], `${label} page sizes`);
  assert.equal(beforeReplyId, null, `${label} final cursor`);
  assert.equal(new Set(collected).size, 1_001, `${label} cross-page duplicates`);
  assert.deepEqual(collected, cursorReplyIds, `${label} must recover every reply without gaps`);
}

await collectCursorReplies("/api/support", memberCookie, "member");
await collectCursorReplies("/api/admin/support", adminCookie, "admin");

console.log("고객센터 검증 통과: 사진 답글·권한 격리·명시적 읽음 확인·요청 제한·목록/답변 커서 페이지네이션·검색");
