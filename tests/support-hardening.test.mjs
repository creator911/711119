import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("관리자 문의 화면은 불안정한 부모 콜백과 빠른 선택 전환을 안전하게 처리한다", async () => {
  const source = await read("../app/admin/AdminSupport.tsx");
  assert.match(source, /const onChangedRef = useRef\(onChanged\)/);
  assert.match(source, /useEffect\(\(\) => \{ onChangedRef\.current = onChanged; \}, \[onChanged\]\)/);
  assert.match(source, /<AdminSupportView key=\{props\.kind\}/);
  assert.match(source, /listSequenceRef/);
  assert.match(source, /detailSequenceRef/);
  assert.match(source, /listAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /detailAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /selectedIdRef\.current !== id/);
  assert.match(source, /const targetId = selectedIdRef\.current/);
  assert.match(source, /selectedIdRef\.current === targetId/);
  assert.match(source, /body: JSON\.stringify\(\{ viewed: true, viewedThroughReplyId: selectedInquiry\.latestReplyId \}\)/);
  assert.match(source, /result\.viewed !== true[\s\S]*loadInquiry\(id, true\)/);
  assert.match(source, /const refreshPage = pageRef\.current/);
  assert.match(source, /const refreshQuery = queryRef\.current/);
  assert.match(source, /const openInquiryId = selectedIdRef\.current/);
  assert.match(source, /openInquiryId \? loadInquiry\(openInquiryId, true\)/);
  assert.match(source, /beforeReplyId: String\(cursor\)/);
  assert.match(source, /className="inquiry-admin-replies-more"/);
  assert.match(source, /resetReplyPagination\(\)/);
  assert.match(source, /replyPageAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /new Set\(current\.map\(\(reply\) => reply\.id\)\)/);
  assert.doesNotMatch(source, /\[kind, onChanged\]/);
});

test("회원 문의 화면은 계정 전환과 오래된 응답을 격리하고 현재 페이지를 갱신한다", async () => {
  const source = await read("../app/components/Portal.tsx");
  assert.match(source, /supportListSequenceRef/);
  assert.match(source, /supportDetailSequenceRef/);
  assert.match(source, /supportListAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /supportDetailAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /selectedInquiryIdRef\.current !== id/);
  assert.match(source, /const resetSupportState = useCallback/);
  assert.match(source, /resetSupportState\(\);\s*setLevelProgressOpen\(false\)/);
  assert.match(source, /const logout = async \(\) => \{\s*resetSupportState\(\)/);
  assert.match(source, /response\.status === 401 && session === supportSessionSequenceRef\.current[\s\S]*handleLevelSessionExpired\(\)/);
  assert.match(source, /loggedIn && selectedInquiry && <SupportDetail/);
  assert.match(source, /sameInquiryTab && supportPage === 1[\s\S]*void loadSupport\(next, 1\)/);
  assert.match(source, /setSupportInquiries\(\(current\) => current\.map\(\(item\) => item\.id === targetId \? \{ \.\.\.item, status: "open"/);
  assert.match(source, /setSelectedInquiry\(\(current\) => current\?\.id === targetId \? \{ \.\.\.current, status: "open"/);
  assert.match(source, /const stillInTargetBoard = viewRef\.current === targetKind/);
  assert.match(source, /const refreshPage = supportPageRef\.current/);
  assert.match(source, /loadSupport\(targetKind, refreshPage, true\)/);
  assert.match(source, /supportSessionSequenceRef/);
  assert.match(source, /body: JSON\.stringify\(\{ viewed: true, viewedThroughReplyId: selectedInquiry\.latestReplyId \}\)/);
  assert.match(source, /result\.viewed !== true[\s\S]*loadSupportInquiry\(id, requestKind, true\)/);
  assert.match(source, /onReply: \(body: string\) => Promise<boolean>/);
  assert.match(source, /const resetSupportReplyPagination = useCallback/);
  assert.match(source, /supportReplyPageAbortRef\.current\?\.abort\(\)/);
  assert.match(source, /beforeReplyId: String\(cursor\)/);
  assert.match(source, /sequence !== supportReplyPageSequenceRef\.current/);
  assert.match(source, /className="support-replies-more"/);
  const replyResetPoints = [...source.matchAll(/setSupportReplies\(\[\]\);/g)];
  assert.ok(replyResetPoints.length >= 6);
  for (const point of replyResetPoints) {
    assert.match(source.slice(point.index, point.index + 140), /resetSupportReplyPagination\(\)/);
  }
});

test("고객센터 목록 API는 서버 페이지네이션과 제한값을 적용한다", async () => {
  const [adminRoute, memberRoute] = await Promise.all([
    read("../app/api/admin/support/route.ts"),
    read("../app/api/support/route.ts"),
  ]);
  assert.match(adminRoute, /const DEFAULT_PAGE_SIZE = 30/);
  assert.match(adminRoute, /const MAX_PAGE_SIZE = 100/);
  assert.match(adminRoute, /LIMIT \? OFFSET \?/);
  assert.match(adminRoute, /WITH page_ids AS/);
  assert.match(adminRoute, /ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL/);
  assert.match(adminRoute, /adminSupportPrefixSearch/);
  assert.match(adminRoute, /totalPages/);
  assert.match(adminRoute, /Cache-Control": "private, no-store"/);
  assert.doesNotMatch(adminRoute, /LIMIT 300/);
  assert.doesNotMatch(adminRoute, /20_000|WITH candidates AS/);
  assert.match(memberRoute, /const SUPPORT_PAGE_SIZE = 20/);
  assert.match(memberRoute, /LIMIT \? OFFSET \?/);
  assert.match(memberRoute, /totalPages/);
  assert.doesNotMatch(memberRoute, /LIMIT 100/);
});

test("관리자 문의 검색은 전체 데이터에서 제목·아이디·닉네임 앞부분을 인덱스로 찾는다", async () => {
  const [route, helper, component] = await Promise.all([
    read("../app/api/admin/support/route.ts"),
    read("../app/lib/admin-support-search.ts"),
    read("../app/admin/AdminSupport.tsx"),
  ]);
  assert.match(helper, /MAX_ADMIN_SUPPORT_SEARCH_CHARACTERS = 80/);
  assert.match(helper, /MAX_ADMIN_SUPPORT_SEARCH_BYTES = 80/);
  assert.match(helper, /replace\(\/\[!%_\]\//);
  assert.match(helper, /support_inquiries_admin_title_nocase_idx/);
  assert.match(helper, /users_username_nocase_id_idx/);
  assert.match(helper, /users_nickname_nocase_id_idx/);
  assert.match(helper, /support_inquiries_member_kind_id_idx/);
  assert.match(route, /SELECT COUNT\(\*\) AS count FROM matched_ids/);
  assert.match(component, /placeholder="제목·아이디·닉네임 앞부분 검색"/);
  assert.match(component, /전체 데이터 앞부분 검색/);
});

test("회원과 관리자 문의 댓글은 잘못된 JSON을 400으로 거절한다", async () => {
  const routes = await Promise.all([
    read("../app/api/admin/support/[id]/route.ts"),
    read("../app/api/support/[id]/route.ts"),
  ]);
  for (const route of routes) {
    assert.match(route, /rawPayload = await request\.json\(\)/);
    assert.match(route, /catch \{[\s\S]*status: 400/);
    assert.match(route, /typeof rawPayload !== "object" \|\| Array\.isArray\(rawPayload\)/);
  }
});

test("문의 읽음 처리는 상세 GET이 아니라 선택 확정 후 PATCH로만 수행한다", async () => {
  const [adminDetailRoute, memberDetailRoute] = await Promise.all([
    read("../app/api/admin/support/[id]/route.ts"),
    read("../app/api/support/[id]/route.ts"),
  ]);
  assert.doesNotMatch(adminDetailRoute, /export async function GET[\s\S]*UPDATE support_inquiries SET staff_unread=0[\s\S]*export async function POST/);
  assert.doesNotMatch(memberDetailRoute, /export async function GET[\s\S]*UPDATE support_inquiries SET member_unread=0[\s\S]*export async function POST/);
  assert.match(adminDetailRoute, /payload\.viewed === true[\s\S]*SET staff_unread=0/);
  assert.match(memberDetailRoute, /export async function PATCH[\s\S]*payload\?\.viewed !== true[\s\S]*SET member_unread=0/);
  for (const route of [adminDetailRoute, memberDetailRoute]) {
    assert.match(route, /viewedThroughReplyId/);
    assert.match(route, /MAX\(r\.id\)/);
    assert.match(route, /NOT EXISTS \(SELECT 1 FROM support_inquiry_replies r WHERE r\.inquiry_id=support_inquiries\.id AND r\.id>\?\)/);
    assert.match(route, /viewed: false/);
  }
});

test("문의 읽음 확인은 마지막으로 본 답글 이후의 새 답글을 지우지 않고 복합 인덱스를 사용한다", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE support_inquiries(id INTEGER PRIMARY KEY, member_unread INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE support_inquiry_replies(id INTEGER PRIMARY KEY, inquiry_id INTEGER NOT NULL);
      CREATE INDEX support_inquiry_replies_inquiry_id_idx ON support_inquiry_replies(inquiry_id,id);
      INSERT INTO support_inquiries(id,member_unread) VALUES(1,1);
      INSERT INTO support_inquiry_replies(id,inquiry_id) VALUES(10,1);
    `);
    const sql = `
      UPDATE support_inquiries SET member_unread=0
      WHERE id=? AND NOT EXISTS (
        SELECT 1 FROM support_inquiry_replies r
        WHERE r.inquiry_id=support_inquiries.id AND r.id>?
      )
    `;
    const plan = database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 10).map(({ detail }) => String(detail));
    assert.ok(plan.some((detail) => detail.includes("support_inquiry_replies_inquiry_id_idx")), plan.join(" | "));
    assert.equal(database.prepare(sql).run(1, 9).changes, 0);
    assert.equal(database.prepare("SELECT member_unread FROM support_inquiries WHERE id=1").get().member_unread, 1);
    assert.equal(database.prepare(sql).run(1, 10).changes, 1);
    assert.equal(database.prepare("SELECT member_unread FROM support_inquiries WHERE id=1").get().member_unread, 0);
  } finally {
    database.close();
  }
});

test("회원 문의와 답글은 원자적 고정 구간 요청 제한을 사용한다", async () => {
  const [inquiryRoute, replyRoute, limiter] = await Promise.all([
    read("../app/api/support/route.ts"),
    read("../app/api/support/[id]/route.ts"),
    read("../app/lib/support-rate-limit.ts"),
  ]);
  assert.match(inquiryRoute, /consumeSupportWriteLimit\(env\.DB, user\.id, "inquiry"\)/);
  assert.match(replyRoute, /consumeSupportWriteLimit\(env\.DB, user\.id, "reply"\)/);
  assert.match(limiter, /ON CONFLICT\(actor_key,action,window_start\) DO UPDATE/);
  assert.match(limiter, /status: 429/);
  assert.match(limiter, /"Retry-After"/);
});

test("문의 상세는 최신 답글부터 500개씩 커서로 안전하게 반환한다", async () => {
  const routes = await Promise.all([
    read("../app/api/admin/support/[id]/route.ts"),
    read("../app/api/support/[id]/route.ts"),
  ]);
  for (const route of routes) {
    assert.match(route, /LEFT JOIN support_stats s ON s\.inquiry_id=i\.id/);
    assert.match(route, /COALESCE\(s\.reply_count,0\) AS replyCount/);
    assert.match(route, /beforeReplyId/);
    assert.match(route, /AND id<\?/);
    assert.match(route, /ORDER BY id DESC LIMIT 501/);
    assert.match(route, /replies\.results\.slice\(0, 500\)\.reverse\(\)/);
    assert.match(route, /previousReplyCursor/);
    assert.match(route, /Cache-Control": "private, no-store"/);
  }
});
