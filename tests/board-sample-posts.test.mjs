import assert from "node:assert/strict";
import test from "node:test";
import { getSampleBoardPosts } from "../app/lib/board-sample-posts.ts";
import { COMMUNITY_TAGS } from "../app/lib/community-tags.ts";
import { isInPopularWindow } from "../app/lib/popular-posts.ts";

const kinds = ["notices", "reviews", "events", "community"];
const now = new Date("2026-07-21T12:00:00.000Z");

test("게시판별 예시 글은 각각 30개이며 제목과 본문을 반복하지 않는다", () => {
  const allIds = new Set();
  for (const kind of kinds) {
    const posts = getSampleBoardPosts(kind, now);
    assert.equal(posts.length, 30, `${kind} sample count`);
    assert.equal(new Set(posts.map(({ title }) => title)).size, 30, `${kind} title uniqueness`);
    assert.equal(new Set(posts.map(({ body }) => body)).size, 30, `${kind} body uniqueness`);
    for (const post of posts) {
      assert.equal(allIds.has(post.id), false, `duplicate sample id: ${post.id}`);
      allIds.add(post.id);
      assert.ok(post.body.length >= 40);
      assert.equal(post.commentCount, 0, "예시 글에는 실제 댓글이 없는 만큼 댓글 수를 표시하지 않는다");
      if (kind === "community") {
        assert.ok(Array.isArray(post.communityTags));
        assert.ok(post.communityTags.length >= 1, "커뮤니티 예시 글에는 머릿글이 하나 이상 있어야 한다");
        assert.ok(post.communityTags.every((tag) => COMMUNITY_TAGS.includes(tag)), "허용된 커뮤니티 머릿글만 사용한다");
      } else {
        assert.deepEqual(post.communityTags, []);
      }
    }
  }
  assert.equal(allIds.size, 120);
});

test("후기와 커뮤니티 예시 글은 주간 인기글과 이전 글을 모두 포함한다", () => {
  for (const kind of ["reviews", "community"]) {
    const posts = getSampleBoardPosts(kind, now);
    const recent = posts.filter((post) => isInPopularWindow(post, now.getTime()));
    assert.equal(recent.length, 14, `${kind} recent sample count`);
    assert.equal(posts.length - recent.length, 16, `${kind} older sample count`);
  }
});
