import assert from "node:assert/strict";

const baseUrl = process.env.TEST_BASE_URL;
assert.ok(baseUrl, "TEST_BASE_URL이 지정된 격리 테스트 서버에서만 실행할 수 있습니다.");
const adminUsername = process.env.TEST_ADMIN_USERNAME;
const adminPassword = process.env.TEST_ADMIN_PASSWORD;

const baseHostname = new URL(baseUrl).hostname;
const localHostnames = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
if (!localHostnames.has(baseHostname) && process.env.ALLOW_REMOTE_POSTS_INTEGRATION !== "1") {
  throw new Error(
    `Refusing to run posts integration tests against non-local host "${baseHostname}". ` +
      "Set ALLOW_REMOTE_POSTS_INTEGRATION=1 only when remote test data is explicitly intended.",
  );
}

if (!adminUsername || !adminPassword) throw new Error("TEST_ADMIN_USERNAME and TEST_ADMIN_PASSWORD are required.");
const unique = Date.now().toString(36);
const cleanupUsernames = new Set();
let cleanupAdminCookie = "";

async function getCaptcha() {
  const response = await fetch(`${baseUrl}/api/captcha?t=${Date.now()}`);
  assert.equal(response.status, 200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  const svg = await response.text();
  const answer = [...svg.matchAll(/<text[^>]*>(\d)<\/text>/g)].map((match) => match[1]).join("");
  assert.match(answer, /^\d{5}$/);
  return { answer, cookie };
}

async function registerAndLogin(prefix, nicknamePrefix, ip) {
  const memberCaptcha = await getCaptcha();
  const memberUsername = `${prefix}${unique}`.slice(0, 20);
  const memberNickname = `${nicknamePrefix}${unique}`.slice(0, 12);
  const memberPassword = "SafePass!2026";
  cleanupUsernames.add(memberUsername);
  const memberRegistration = await fetch(`${baseUrl}/api/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: memberCaptcha.cookie, "X-Forwarded-For": ip },
    body: JSON.stringify({ username: memberUsername, nickname: memberNickname, password: memberPassword, passwordConfirm: memberPassword, captchaAnswer: memberCaptcha.answer }),
  });
  assert.equal(memberRegistration.status, 201, JSON.stringify(await memberRegistration.clone().json()));
  const memberLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": ip },
    body: JSON.stringify({ username: memberUsername, password: memberPassword }),
  });
  assert.equal(memberLogin.status, 200);
  return { username: memberUsername, nickname: memberNickname, cookie: memberLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "" };
}

try {
const anonymous = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ category: "reviews", title: "비로그인 글", body: "등록되면 안 됩니다." }),
});
assert.equal(anonymous.status, 401);

const captcha = await getCaptcha();
const username = `post${unique}`.slice(0, 20);
cleanupUsernames.add(username);
const nickname = `작성자${unique}`.slice(0, 12);
const password = "SafePass!2026";
const registration = await fetch(`${baseUrl}/api/auth/register`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: captcha.cookie },
  body: JSON.stringify({ username, nickname, password, passwordConfirm: password, captchaAnswer: captcha.answer }),
});
assert.equal(registration.status, 201, JSON.stringify(await registration.clone().json()));

const login = await fetch(`${baseUrl}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
assert.equal(login.status, 200);
const memberCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
assert.match(memberCookie, /^cn_session=/);

const forbidden = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "events", title: "회원 이벤트", body: "등록되면 안 됩니다." }),
});
assert.equal(forbidden.status, 403);

const title = `통합 테스트 후기 ${unique}`;
const body = "로그인 회원이 작성한 게시글 내용입니다. 목록과 관리자 화면에 반영되어야 합니다.";
const creation = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "reviews", title, body }),
});
assert.equal(creation.status, 201, JSON.stringify(await creation.clone().json()));
const created = await creation.json();
assert.equal(created.post.title, title);
assert.equal(created.post.body, body);
assert.equal(created.post.authorLevel, 1);

const listing = await fetch(`${baseUrl}/api/posts?category=reviews`);
assert.equal(listing.status, 200);
const listingData = await listing.json();
const listed = listingData.posts.find((post) => post.id === created.post.id);
assert.equal(listed.title, title);
assert.equal(listed.body, body);
assert.equal(listed.authorLevel, 1);
assert.equal(listed.commentCount, 0);
assert.equal(listed.isNotice, 0);

const anonymousComment = await fetch(`${baseUrl}/api/posts/${created.post.id}/comments`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ body: "비로그인 댓글" }),
});
assert.equal(anonymousComment.status, 401);

const commentBody = `댓글 저장 확인 ${unique}`;
const commentCreation = await fetch(`${baseUrl}/api/posts/${created.post.id}/comments`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ body: commentBody }),
});
assert.equal(commentCreation.status, 201, JSON.stringify(await commentCreation.clone().json()));

const detail = await fetch(`${baseUrl}/api/posts/${created.post.id}`);
assert.equal(detail.status, 200);
const detailData = await detail.json();
assert.equal(detailData.post.title, title);
assert.equal(detailData.post.commentCount, 1);
assert.equal(detailData.post.views, 1);
assert.ok(detailData.comments.some((comment) => comment.body === commentBody));

const authorDetail = await fetch(`${baseUrl}/api/posts/${created.post.id}`, { headers: { Cookie: memberCookie } });
assert.equal(authorDetail.status, 200);
const authorDetailData = await authorDetail.json();
assert.equal(authorDetailData.post.isOwn, true);
assert.equal(authorDetailData.post.canEdit, true);
assert.equal(authorDetailData.post.canDelete, true);

const selfRecommendation = await fetch(`${baseUrl}/api/posts/${created.post.id}/recommend`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ vote: "up" }),
});
assert.equal(selfRecommendation.status, 403);

const voter = await registerAndLogin("voter", "투표", "203.0.113.241");
const negativeVoter = await registerAndLogin("negative", "반대", "203.0.113.242");
const secondNegativeVoter = await registerAndLogin("negative2", "반대둘", "203.0.113.243");

const outsiderDetail = await fetch(`${baseUrl}/api/posts/${created.post.id}`, { headers: { Cookie: voter.cookie } });
assert.equal(outsiderDetail.status, 200);
const outsiderDetailData = await outsiderDetail.json();
assert.equal(outsiderDetailData.post.isOwn, false);
assert.equal(outsiderDetailData.post.canEdit, false);
assert.equal(outsiderDetailData.post.canDelete, false);

const anonymousEdit = await fetch(`${baseUrl}/api/posts/${created.post.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ title: `비로그인 수정 ${unique}`, body: "수정되면 안 됩니다." }),
});
assert.equal(anonymousEdit.status, 401);

const outsiderEdit = await fetch(`${baseUrl}/api/posts/${created.post.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ title: `타인 수정 ${unique}`, body: "다른 회원이 수정하면 안 됩니다." }),
});
assert.equal(outsiderEdit.status, 403);
assert.equal((await fetch(`${baseUrl}/api/posts/${created.post.id}`, { headers: { Cookie: memberCookie } })).status, 200);

const editedTitle = `작성자 수정 후기 ${unique}`;
const editedBody = "작성자 본인이 안전하게 수정한 게시글 내용입니다.";
const authorEdit = await fetch(`${baseUrl}/api/posts/${created.post.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ title: editedTitle, body: editedBody }),
});
assert.equal(authorEdit.status, 200, JSON.stringify(await authorEdit.clone().json()));
const authorEditData = await authorEdit.json();
assert.equal(authorEditData.post.title, editedTitle);
assert.equal(authorEditData.post.body, editedBody);
assert.equal(authorEditData.post.canEdit, true);
const editedDetail = await (await fetch(`${baseUrl}/api/posts/${created.post.id}`, { headers: { Cookie: memberCookie } })).json();
assert.equal(editedDetail.post.title, editedTitle);
assert.equal(editedDetail.post.body, editedBody);

const pollConfig = Buffer.from(JSON.stringify({ question: "선호하는 이용 시간은 언제인가요?", options: ["오전", "오후", "저녁"] }), "utf8").toString("base64url");
const pollPostResponse = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "community", title: `게시글 투표 검증 ${unique}`, body: `<p>투표 위 문장</p><blockquote class="editor-poll-card" data-poll-config="${pollConfig}"><strong>VOTE</strong><h4>선호하는 이용 시간은 언제인가요?</h4><ol><li>오전</li><li>오후</li><li>저녁</li></ol></blockquote><p>투표 아래 문장</p>` }),
});
assert.equal(pollPostResponse.status, 201, JSON.stringify(await pollPostResponse.clone().json()));
const pollPost = (await pollPostResponse.json()).post;
const pollBefore = await (await fetch(`${baseUrl}/api/posts/${pollPost.id}`, { headers: { Cookie: voter.cookie } })).json();
assert.equal(pollBefore.poll.selectedOptionId, null);
assert.equal(pollBefore.poll.options.length, 3);
assert.match(pollBefore.post.body, /post-poll-slot/);
const pollVoteResponse = await fetch(`${baseUrl}/api/posts/${pollPost.id}/poll`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ optionId: pollBefore.poll.options[1].id }),
});
assert.equal(pollVoteResponse.status, 200, JSON.stringify(await pollVoteResponse.clone().json()));
const pollAfter = (await pollVoteResponse.json()).poll;
assert.equal(pollAfter.selectedOptionId, pollBefore.poll.options[1].id);
assert.equal(pollAfter.totalVotes, 1);
assert.equal(pollAfter.options[1].percentage, 100);
const duplicatePollVote = await fetch(`${baseUrl}/api/posts/${pollPost.id}/poll`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ optionId: pollBefore.poll.options[0].id }),
});
assert.equal(duplicatePollVote.status, 409);

const youtubeEmbed = '<div class="editor-youtube-block"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="유튜브 동영상" loading="lazy" allow="autoplay; encrypted-media" referrerpolicy="strict-origin-when-cross-origin" allowfullscreen="allowfullscreen"></iframe></div>';
const youtubePostResponse = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "community", title: `유튜브 미리보기 검증 ${unique}`, body: `${youtubeEmbed}<iframe src="https://example.com/unsafe"></iframe>` }),
});
assert.equal(youtubePostResponse.status, 201, JSON.stringify(await youtubePostResponse.clone().json()));
const youtubePost = (await youtubePostResponse.json()).post;
assert.match(youtubePost.body, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);
assert.doesNotMatch(youtubePost.body, /example\.com|<iframe(?![^>]*\ssrc=)/);

const invalidReport = await fetch(`${baseUrl}/api/posts/${created.post.id}/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ reason: "기타" }),
});
assert.equal(invalidReport.status, 400);

const recommendation = await fetch(`${baseUrl}/api/posts/${created.post.id}/recommend`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ vote: "up" }),
});
assert.equal(recommendation.status, 200, JSON.stringify(await recommendation.clone().json()));
const recommendationData = await recommendation.json();
assert.equal(recommendationData.likes, 1);
assert.equal(recommendationData.dislikes, 0);
assert.equal(recommendationData.autoDeleted, false);

const duplicateRecommendation = await fetch(`${baseUrl}/api/posts/${created.post.id}/recommend`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ vote: "down" }),
});
assert.equal(duplicateRecommendation.status, 409);

const report = await fetch(`${baseUrl}/api/posts/${created.post.id}/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ reason: "사기" }),
});
assert.equal(report.status, 200, JSON.stringify(await report.clone().json()));
const reportData = await report.json();
assert.equal(reportData.reportCount, 1);
assert.equal(reportData.autoDeleted, false);

const duplicateReport = await fetch(`${baseUrl}/api/posts/${created.post.id}/report`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ reason: "도배" }),
});
assert.equal(duplicateReport.status, 409);

const downvote = await fetch(`${baseUrl}/api/posts/${created.post.id}/recommend`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: negativeVoter.cookie },
  body: JSON.stringify({ vote: "down" }),
});
assert.equal(downvote.status, 200, JSON.stringify(await downvote.clone().json()));
const downvoteData = await downvote.json();
assert.equal(downvoteData.dislikes, 1);
assert.equal(downvoteData.autoDeleted, false);
assert.equal((await fetch(`${baseUrl}/api/posts/${created.post.id}`)).status, 200);

const secondDownvote = await fetch(`${baseUrl}/api/posts/${created.post.id}/recommend`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: secondNegativeVoter.cookie },
  body: JSON.stringify({ vote: "down" }),
});
assert.equal(secondDownvote.status, 200, JSON.stringify(await secondDownvote.clone().json()));
const secondDownvoteData = await secondDownvote.json();
assert.equal(secondDownvoteData.dislikes, 2);
assert.equal(secondDownvoteData.autoDeleted, true);
assert.equal((await fetch(`${baseUrl}/api/posts/${created.post.id}`)).status, 404);

const deletionTarget = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "community", title: `관리자 삭제 대상 ${unique}`, body: "관리자만 삭제할 수 있어야 합니다." }),
});
assert.equal(deletionTarget.status, 201);
const deletionTargetData = await deletionTarget.json();
const ordinaryDelete = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, { method: "DELETE", headers: { Cookie: negativeVoter.cookie } });
assert.equal(ordinaryDelete.status, 403);

const authorDeletionTarget = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "reviews", title: `작성자 삭제 대상 ${unique}`, body: "작성자 본인만 삭제할 수 있어야 합니다." }),
});
assert.equal(authorDeletionTarget.status, 201);
const authorDeletionTargetData = await authorDeletionTarget.json();
assert.equal((await fetch(`${baseUrl}/api/posts/${authorDeletionTargetData.post.id}`, { method: "DELETE", headers: { Cookie: voter.cookie } })).status, 403);
assert.equal((await fetch(`${baseUrl}/api/posts/${authorDeletionTargetData.post.id}`, { method: "DELETE", headers: { Cookie: memberCookie } })).status, 200);
assert.equal((await fetch(`${baseUrl}/api/posts/${authorDeletionTargetData.post.id}`)).status, 404);

const ordinaryPin = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "community", title: `일반회원 고정 시도 ${unique}`, body: "레벨 10이 아니면 상단 고정을 사용할 수 없어야 합니다.", isPinned: true }),
});
assert.equal(ordinaryPin.status, 403);

const adminLogin = await fetch(`${baseUrl}/api/admin/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username: adminUsername, password: adminPassword }),
});
assert.equal(adminLogin.status, 200);
const adminCookie = adminLogin.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
cleanupAdminCookie = adminCookie;
const overview = await fetch(`${baseUrl}/api/admin/overview`, { headers: { Cookie: adminCookie } });
assert.equal(overview.status, 200);
const overviewData = await overview.json();
assert.ok(overviewData.posts.some((post) => post.title === editedTitle));
const voterMember = overviewData.members.find((member) => member.username === voter.username);
assert.ok(voterMember);

const ownerDetail = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, { headers: { Cookie: adminCookie } });
assert.equal(ownerDetail.status, 200);
const ownerDetailData = await ownerDetail.json();
assert.equal(ownerDetailData.post.isOwn, false);
assert.equal(ownerDetailData.post.canEdit, true);
assert.equal(ownerDetailData.post.canDelete, true);
const ownerEditedTitle = `오너 수정 완료 ${unique}`;
const ownerEdit = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ title: ownerEditedTitle, body: "오너 관리자 쿠키로 안전하게 수정한 내용입니다." }),
});
assert.equal(ownerEdit.status, 200, JSON.stringify(await ownerEdit.clone().json()));
assert.equal((await ownerEdit.json()).post.title, ownerEditedTitle);

const ownerDeleteTarget = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: memberCookie },
  body: JSON.stringify({ category: "community", title: `오너 삭제 대상 ${unique}`, body: "오너 관리자 쿠키 삭제 검증용 게시글입니다." }),
});
assert.equal(ownerDeleteTarget.status, 201);
const ownerDeleteTargetData = await ownerDeleteTarget.json();
assert.equal((await fetch(`${baseUrl}/api/posts/${ownerDeleteTargetData.post.id}`, { method: "DELETE", headers: { Cookie: adminCookie } })).status, 200);
assert.equal((await fetch(`${baseUrl}/api/posts/${ownerDeleteTargetData.post.id}`)).status, 404);

const promoteVoter = await fetch(`${baseUrl}/api/admin/members`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: adminCookie },
  body: JSON.stringify({ id: voterMember.id, nickname: voter.nickname, points: 0, level: 10, status: "active" }),
});
assert.equal(promoteVoter.status, 200);

const pinnedCommunity = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ category: "community", title: `커뮤니티 상단 고정 ${unique}`, body: "레벨 10 관리자가 등록한 커뮤니티 고정글입니다.", isPinned: true }),
});
assert.equal(pinnedCommunity.status, 201);
const pinnedCommunityData = await pinnedCommunity.json();
assert.equal(pinnedCommunityData.post.isPinned, true);

const regularCommunity = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ category: "community", title: `최신 일반글 ${unique}`, body: "고정글보다 나중에 작성된 일반 커뮤니티 글입니다." }),
});
assert.equal(regularCommunity.status, 201);
const regularCommunityData = await regularCommunity.json();

const communityOrder = await (await fetch(`${baseUrl}/api/posts?category=community`)).json();
assert.ok(communityOrder.posts.findIndex((post) => post.id === pinnedCommunityData.post.id) < communityOrder.posts.findIndex((post) => post.id === regularCommunityData.post.id));

const pinnedReview = await fetch(`${baseUrl}/api/posts`, {
  method: "POST",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ category: "reviews", title: `후기 상단 고정 ${unique}`, body: "레벨 10 관리자가 등록한 후기 고정글입니다.", isPinned: true }),
});
assert.equal(pinnedReview.status, 201);
assert.equal((await pinnedReview.json()).post.isPinned, true);

const adminDetail = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, { headers: { Cookie: voter.cookie } });
assert.equal(adminDetail.status, 200);
const adminDetailData = await adminDetail.json();
assert.equal(adminDetailData.post.canEdit, true);
assert.equal(adminDetailData.post.canDelete, true);
const adminEditedTitle = `관리자 수정 완료 ${unique}`;
const adminEdit = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, {
  method: "PATCH",
  headers: { "Content-Type": "application/json", Cookie: voter.cookie },
  body: JSON.stringify({ title: adminEditedTitle, body: "레벨 10 관리자가 수정한 내용입니다." }),
});
assert.equal(adminEdit.status, 200, JSON.stringify(await adminEdit.clone().json()));
assert.equal((await adminEdit.json()).post.title, adminEditedTitle);
const adminDelete = await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`, { method: "DELETE", headers: { Cookie: voter.cookie } });
assert.equal(adminDelete.status, 200);
assert.equal((await fetch(`${baseUrl}/api/posts/${deletionTargetData.post.id}`)).status, 404);

console.log("게시글 검증 통과: 작성자·관리자 수정/삭제, 타 회원 403 차단, 본문 투표·유튜브·추천·신고·자동삭제, 커뮤니티·후기 상단 고정");
} finally {
  if (cleanupAdminCookie && cleanupUsernames.size > 0) {
    try {
      const cleanupOverviewResponse = await fetch(`${baseUrl}/api/admin/overview`, {
        headers: { Cookie: cleanupAdminCookie },
      });
      assert.equal(cleanupOverviewResponse.status, 200);
      const cleanupOverview = await cleanupOverviewResponse.json();
      const cleanupMembers = cleanupOverview.members
        .filter((member) => cleanupUsernames.has(member.username))
        .sort((left, right) => Number(right.level) - Number(left.level));

      for (const member of cleanupMembers) {
        try {
          const cleanupResponse = await fetch(`${baseUrl}/api/admin/members`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Cookie: cleanupAdminCookie },
            body: JSON.stringify({
              id: member.id,
              nickname: member.nickname,
              points: Number(member.points),
              level: 1,
              status: "suspended",
              isDirector: false,
              isPartner: false,
            }),
          });
          if (cleanupResponse.status !== 200) {
            console.error(`Failed to clean up test member ${member.username}: HTTP ${cleanupResponse.status}`);
          }
        } catch (memberCleanupError) {
          console.error(`Failed to clean up test member ${member.username}:`, memberCleanupError);
        }
      }
    } catch (cleanupError) {
      console.error("Posts integration test account cleanup failed:", cleanupError);
    }
  }
}
