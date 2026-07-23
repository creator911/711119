import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const portalSource = readFileSync(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");

test("공지·커뮤니티·후기·이벤트 게시판은 저장된 게시글만 표시한다", () => {
  assert.doesNotMatch(portalSource, /board-sample-posts|getSampleBoardPosts|samplePosts/);
  assert.match(portalSource, /const memberPosts = livePosts\.map\(livePostToBoardDisplayPost\)/);
  assert.match(portalSource, /const allPosts = \[\.\.\.memberPosts\]/);
});

test("메인 후기·커뮤니티 미리보기도 실제 API 게시글을 사용한다", () => {
  assert.match(portalSource, /view === "home"[\s\S]*?\["reviews", "community"\]/);
  assert.match(portalSource, /posts=\{\(livePosts\.reviews \?\? \[\]\)\.slice\(0, 5\)\.map\(livePostToBoardDisplayPost\)\}/);
  assert.match(portalSource, /posts=\{\(livePosts\.community \?\? \[\]\)\.slice\(0, 5\)\.map\(livePostToBoardDisplayPost\)\}/);
});
