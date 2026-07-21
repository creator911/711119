import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

const baseHostname = new URL(baseUrl).hostname;
const localHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!localHostnames.has(baseHostname) && process.env.ALLOW_REMOTE_VENDOR_INTEGRATION !== "1") {
  throw new Error(
    `Refusing to run vendor integration tests against non-local host "${baseHostname}". ` +
      "Set ALLOW_REMOTE_VENDOR_INTEGRATION=1 only when remote test data is explicitly intended.",
  );
}

if (!adminUsername || !adminPassword) {
  throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
}

const unique = Date.now().toString(36);
const password = "SafePass!2026";
const assignedRegion = "서울 비강남";
const primaryDistrict = "영등포";
const secondaryDistrict = "마포";
const unassignedDistrict = "홍대";

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

function assertNoAuthorId(value, label) {
  assert.equal(JSON.stringify(value).includes('"authorId"'), false, `${label} must not expose authorId`);
}

async function getCaptcha() {
  const response = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
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

async function loadOverview(adminCookie) {
  const response = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
  await expectStatus(response, 200, "admin overview");
  const overview = await response.json();
  for (const member of overview.members) {
    assert.equal(typeof member.isDirector, "boolean", "overview isDirector must be Boolean");
    assert.equal(typeof member.isPartner, "boolean", "overview isPartner must be Boolean");
  }
  return overview;
}

async function updateMember(adminCookie, member, changes) {
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
  await expectStatus(response, 200, `member update (${member.username})`);
}

function vendorPayload(overrides = {}) {
  return {
    industry: "출장",
    region: assignedRegion,
    district: primaryDistrict,
    title: `업체정보 통합 검증 ${unique}`,
    body: `<p>실장 전용 업체정보 게시글 본문 ${unique}</p>`,
    ...overrides,
  };
}

let cleanupAdminCookie = "";
let cleanupDirectorUsername = "";
let cleanupOutsiderUsername = "";

try {
const anonymousAssignmentList = await fetch(`${baseUrl}/api/admin/director-regions`);
await expectStatus(anonymousAssignmentList, 401, "anonymous assignment list guard");

const anonymousAssignmentUpdate = await fetch(`${baseUrl}/api/admin/director-regions`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ userId: 1, regions: [] }),
});
await expectStatus(anonymousAssignmentUpdate, 401, "anonymous assignment update guard");

const anonymousCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(vendorPayload()),
});
await expectStatus(anonymousCreate, 401, "anonymous vendor post guard");

const director = await registerAndLogin("vdir", "실장검증", "192.0.2.245");
const outsider = await registerAndLogin("vout", "외부검증", "192.0.2.246");
cleanupDirectorUsername = director.username;
cleanupOutsiderUsername = outsider.username;

const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-Forwarded-For": process.env.TEST_ADMIN_IP || "192.0.2.247" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
await expectStatus(adminLogin, 200, "admin login");
const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(adminCookie, /^cn_admin_session=/);
cleanupAdminCookie = adminCookie;

let overview = await loadOverview(adminCookie);
assert.equal(overview.operator?.canManageAdmins, true, "an owner admin credential is required to exercise Lv.10 authorization");
let directorMember = overview.members.find((member) => member.username === director.username);
let outsiderMember = overview.members.find((member) => member.username === outsider.username);
assert.ok(directorMember);
assert.ok(outsiderMember);

const nonDirectorAssignment = await fetch(`${baseUrl}/api/admin/director-regions`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ userId: outsiderMember.id, regions: [{ region: assignedRegion, district: primaryDistrict }] }),
});
await expectStatus(nonDirectorAssignment, 409, "non-director assignment guard");

await updateMember(adminCookie, directorMember, { isDirector: true });

const invalidAssignment = await fetch(`${baseUrl}/api/admin/director-regions`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ userId: directorMember.id, regions: [{ region: assignedRegion, district: "존재하지 않는 지역" }] }),
});
await expectStatus(invalidAssignment, 400, "invalid assignment guard");

const assignmentUpdate = await fetch(`${baseUrl}/api/admin/director-regions`, {
  method: "PUT",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({
    userId: directorMember.id,
    regions: [
      { region: assignedRegion, district: primaryDistrict },
      { region: assignedRegion, district: secondaryDistrict },
    ],
  }),
});
await expectStatus(assignmentUpdate, 200, "director assignment update");
const assignmentUpdateData = await assignmentUpdate.json();
assert.deepEqual(assignmentUpdateData.assignments, [
  { region: assignedRegion, district: primaryDistrict },
  { region: assignedRegion, district: secondaryDistrict },
]);

const assignmentList = await fetch(`${baseUrl}/api/admin/director-regions`, { headers: { Cookie: adminCookie } });
await expectStatus(assignmentList, 200, "admin assignment list");
const assignmentListData = await assignmentList.json();
assert.ok(assignmentListData.assignments.some((entry) => entry.userId === directorMember.id && entry.region === assignedRegion && entry.district === primaryDistrict));
assert.ok(assignmentListData.assignments.some((entry) => entry.userId === directorMember.id && entry.region === assignedRegion && entry.district === secondaryDistrict));

const nonDirectorCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
  body: JSON.stringify(vendorPayload()),
});
await expectStatus(nonDirectorCreate, 403, "non-director create guard");

const multipleIndustryCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ industry: ["출장", "안마"] })),
});
await expectStatus(multipleIndustryCreate, 400, "single industry validation");

const overallIndustryCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ industry: "전체" })),
});
await expectStatus(overallIndustryCreate, 400, "writable industry validation");

const invalidRegionCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ district: "존재하지 않는 지역" })),
});
await expectStatus(invalidRegionCreate, 400, "region pair validation");

const multipleRegionCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ region: [assignedRegion], district: [primaryDistrict] })),
});
await expectStatus(multipleRegionCreate, 400, "single region validation");

const unassignedRegionCreate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ district: unassignedDistrict })),
});
await expectStatus(unassignedRegionCreate, 403, "unassigned region guard");

const creation = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload()),
});
await expectStatus(creation, 201, "assigned director creation");
const creationData = await creation.json();
assertNoAuthorId(creationData, "creation response");
assert.equal(creationData.post.industry, "출장");
assert.equal(creationData.post.region, assignedRegion);
assert.equal(creationData.post.district, primaryDistrict);
assert.equal(creationData.post.isOwn, true);
assert.equal(creationData.post.canEdit, true);
assert.equal(creationData.post.canDelete, true);
const postId = creationData.post.id;

const duplicate = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ industry: "안마", title: `중복 지역 검증 ${unique}` })),
});
await expectStatus(duplicate, 409, "one post per author and detailed region");

const list = await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ industry: "출장", region: assignedRegion, district: primaryDistrict })}`, {
  headers: { Cookie: director.cookie },
});
await expectStatus(list, 200, "vendor post list");
const listData = await list.json();
assertNoAuthorId(listData, "list response");
assert.equal(listData.canWrite, true);
assert.ok(listData.posts.some((post) => post.id === postId));
assert.ok(listData.assignedRegions.some((entry) => entry.region === assignedRegion && entry.district === primaryDistrict && Boolean(entry.used)));

const titleSearch = await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ q: `업체정보 통합 검증 ${unique}` })}`);
await expectStatus(titleSearch, 200, "vendor title search");
const titleSearchData = await titleSearch.json();
assert.ok(titleSearchData.posts.some((post) => post.id === postId), "title search must find the created vendor post");

const bodySearch = await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ q: "실장 전용 업체정보 게시글 본문" })}`);
await expectStatus(bodySearch, 200, "vendor body search");
const bodySearchData = await bodySearch.json();
assert.ok(bodySearchData.posts.some((post) => post.id === postId), "body search must find the created vendor post");

const regionSearch = await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ q: primaryDistrict })}`);
await expectStatus(regionSearch, 200, "vendor region search");
const regionSearchData = await regionSearch.json();
assert.ok(regionSearchData.posts.some((post) => post.id === postId), "district search must find the created vendor post");

const emptySearch = await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ q: `검색결과없음-${unique}` })}`);
await expectStatus(emptySearch, 200, "vendor empty search");
const emptySearchData = await emptySearch.json();
assert.deepEqual(emptySearchData.posts, []);

await expectStatus(
  await fetch(`${baseUrl}/api/vendor-posts?${new URLSearchParams({ q: "가".repeat(81) })}`),
  400,
  "vendor search length validation",
);

const outsiderDetail = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, { headers: { Cookie: outsider.cookie } });
await expectStatus(outsiderDetail, 200, "outsider detail");
const outsiderDetailData = await outsiderDetail.json();
assertNoAuthorId(outsiderDetailData, "detail response");
assert.equal(outsiderDetailData.post.isOwn, false);
assert.equal(outsiderDetailData.post.canEdit, false);
assert.equal(outsiderDetailData.post.canDelete, false);

const outsiderEdit = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
  body: JSON.stringify(vendorPayload({ title: `외부회원 수정 시도 ${unique}` })),
});
await expectStatus(outsiderEdit, 403, "outsider edit guard");

const outsiderDelete = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "DELETE",
  headers: { Cookie: outsider.cookie },
});
await expectStatus(outsiderDelete, 403, "outsider delete guard");

const unchangedDetail = await fetch(`${baseUrl}/api/vendor-posts/${postId}`);
await expectStatus(unchangedDetail, 200, "post remains after outsider attempts");
assert.equal((await unchangedDetail.json()).post.title, vendorPayload().title);

const authorEditedTitle = `작성자 수정 완료 ${unique}`;
const authorEdit = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ industry: "안마", title: authorEditedTitle, body: `<p>작성자가 수정한 본문 ${unique}</p>` })),
});
await expectStatus(authorEdit, 200, "author edit");
const authorEditData = await authorEdit.json();
assertNoAuthorId(authorEditData, "author edit response");
assert.equal(authorEditData.post.title, authorEditedTitle);
assert.equal(authorEditData.post.industry, "안마");

const immutableRegionEdit = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ region: assignedRegion, district: secondaryDistrict, title: `지역 변경 시도 ${unique}` })),
});
await expectStatus(immutableRegionEdit, 409, "vendor post region is immutable");

const ownerDetail = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, { headers: { Cookie: adminCookie } });
await expectStatus(ownerDetail, 200, "owner detail permissions");
const ownerDetailData = await ownerDetail.json();
assert.equal(ownerDetailData.post.isOwn, false);
assert.equal(ownerDetailData.post.canEdit, true);
assert.equal(ownerDetailData.post.canDelete, true);

const ownerEditedTitle = `오너 수정 완료 ${unique}`;
const ownerEdit = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify(vendorPayload({ industry: "건마", title: ownerEditedTitle, body: `<p>오너 관리자 쿠키로 수정한 본문 ${unique}</p>` })),
});
await expectStatus(ownerEdit, 200, "owner edit");
assert.equal((await ownerEdit.json()).post.title, ownerEditedTitle);

const ownerDeleteCreation = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ district: secondaryDistrict, title: `오너 삭제 대상 ${unique}`, body: `<p>오너 삭제 권한 검증 ${unique}</p>` })),
});
await expectStatus(ownerDeleteCreation, 201, "owner delete target creation");
const ownerDeletePost = (await ownerDeleteCreation.json()).post;
await expectStatus(await fetch(`${baseUrl}/api/vendor-posts/${ownerDeletePost.id}`, { method: "DELETE", headers: { Cookie: adminCookie } }), 200, "owner delete");
await expectStatus(await fetch(`${baseUrl}/api/vendor-posts/${ownerDeletePost.id}`), 404, "owner deleted post detail");

overview = await loadOverview(adminCookie);
outsiderMember = overview.members.find((member) => member.username === outsider.username);
assert.ok(outsiderMember);
await updateMember(adminCookie, outsiderMember, { level: 10 });

const level10Detail = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, { headers: { Cookie: outsider.cookie } });
await expectStatus(level10Detail, 200, "Lv.10 detail permissions");
const level10DetailData = await level10Detail.json();
assertNoAuthorId(level10DetailData, "Lv.10 detail response");
assert.equal(level10DetailData.post.isOwn, false);
assert.equal(level10DetailData.post.canEdit, true);
assert.equal(level10DetailData.post.canDelete, true);

const level10EditedTitle = `관리자 수정 완료 ${unique}`;
const level10Edit = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: outsider.cookie },
  body: JSON.stringify(vendorPayload({ industry: "오피", title: level10EditedTitle, body: `<p>Lv.10 관리자가 수정한 본문 ${unique}</p>` })),
});
await expectStatus(level10Edit, 200, "Lv.10 edit");
const level10EditData = await level10Edit.json();
assertNoAuthorId(level10EditData, "Lv.10 edit response");
assert.equal(level10EditData.post.title, level10EditedTitle);
assert.equal(level10EditData.post.industry, "오피");

const level10Delete = await fetch(`${baseUrl}/api/vendor-posts/${postId}`, {
  method: "DELETE",
  headers: { Cookie: outsider.cookie },
});
await expectStatus(level10Delete, 200, "Lv.10 delete");
await expectStatus(await fetch(`${baseUrl}/api/vendor-posts/${postId}`), 404, "hard-deleted post detail");

const recreation = await fetch(`${baseUrl}/api/vendor-posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: director.cookie },
  body: JSON.stringify(vendorPayload({ title: `삭제 후 재등록 ${unique}`, body: `<p>하드 삭제 후 같은 상세지역 재등록 ${unique}</p>` })),
});
await expectStatus(recreation, 201, "hard delete allows same-region recreation");
const recreationData = await recreation.json();
assertNoAuthorId(recreationData, "recreation response");
assert.notEqual(recreationData.post.id, postId);

const authorCleanup = await fetch(`${baseUrl}/api/vendor-posts/${recreationData.post.id}`, {
  method: "DELETE",
  headers: { Cookie: director.cookie },
});
await expectStatus(authorCleanup, 200, "author cleanup delete");

console.log("업체정보 검증 통과: 제목·본문·지역 검색, 실장 지역 배정, 단일 업종·지역, 지역별 1개 제한, 작성자/Lv.10 권한, authorId 비노출, 하드 삭제 후 재등록");
} finally {
  if (cleanupAdminCookie && (cleanupDirectorUsername || cleanupOutsiderUsername)) {
    try {
      const cleanupOverview = await loadOverview(cleanupAdminCookie);
      const cleanupDirector = cleanupOverview.members.find((member) => member.username === cleanupDirectorUsername);
      const cleanupOutsider = cleanupOverview.members.find((member) => member.username === cleanupOutsiderUsername);

      if (cleanupDirector) {
        await updateMember(cleanupAdminCookie, cleanupDirector, { isDirector: false, level: 1, status: "suspended" });
      }
      if (cleanupOutsider) {
        await updateMember(cleanupAdminCookie, cleanupOutsider, { isDirector: false, level: 1, status: "suspended" });
      }
    } catch (cleanupError) {
      console.error("Vendor integration test account cleanup failed:", cleanupError);
    }
  }
}
