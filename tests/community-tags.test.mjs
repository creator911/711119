import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  COMMUNITY_TAGS,
  communityTagsFromMask,
  isCommunityBoardCategory,
  validateCommunityTags,
} from "../app/lib/community-tags.ts";

test("커뮤니티 머릿글은 정해진 다섯 개와 고정된 표시 순서를 사용한다", () => {
  assert.deepEqual([...COMMUNITY_TAGS], ["후방", "꿀팁", "일상", "유머", "이슈"]);
  assert.equal(isCommunityBoardCategory("community"), true);
  assert.equal(isCommunityBoardCategory("gifs"), true);
  assert.equal(isCommunityBoardCategory("reviews"), false);
  assert.equal(isCommunityBoardCategory(null), false);
});

test("커뮤니티 글은 머릿글을 하나 이상 선택해야 한다", () => {
  for (const value of [undefined, null, "일상", []]) {
    assert.deepEqual(validateCommunityTags(value), {
      ok: false,
      error: "머릿글을 하나 이상 선택해 주세요.",
    });
  }
});

test("허용되지 않은 값과 중복 머릿글을 거부한다", () => {
  assert.deepEqual(validateCommunityTags(["일상", "광고"]), {
    ok: false,
    error: "선택할 수 없는 머릿글이 포함되어 있습니다.",
  });
  assert.deepEqual(validateCommunityTags(["일상", 1]), {
    ok: false,
    error: "선택할 수 없는 머릿글이 포함되어 있습니다.",
  });
  assert.deepEqual(validateCommunityTags(["꿀팁", "꿀팁"]), {
    ok: false,
    error: "같은 머릿글은 한 번만 선택할 수 있습니다.",
  });
});

test("선택 순서와 무관하게 머릿글과 비트마스크를 기준 순서로 정규화한다", () => {
  assert.deepEqual(validateCommunityTags(["이슈", "후방", "꿀팁"]), {
    ok: true,
    tags: ["후방", "꿀팁", "이슈"],
    mask: 19,
  });
  assert.deepEqual(validateCommunityTags([...COMMUNITY_TAGS]), {
    ok: true,
    tags: ["후방", "꿀팁", "일상", "유머", "이슈"],
    mask: 31,
  });
});

test("저장된 마스크를 머릿글로 복원하고 기존 커뮤니티 글은 일상으로 표시한다", () => {
  assert.deepEqual(communityTagsFromMask(18, "community"), ["꿀팁", "이슈"]);
  assert.deepEqual(communityTagsFromMask(0, "community"), ["일상"]);
  assert.deepEqual(communityTagsFromMask(0, "gifs"), ["일상"]);
  assert.deepEqual(communityTagsFromMask(undefined, "community"), ["일상"]);
  assert.deepEqual(communityTagsFromMask(31, "reviews"), []);
});

test("커뮤니티 작성·수정 화면과 주요 글 목록에 머릿글 UI가 연결되어 있다", async () => {
  const [portal, styles] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(portal, /<legend>머릿글 선택 <em>필수 · 1개 이상<\/em><\/legend>/);
  assert.match(portal, /name="communityTags" value=\{tag\}/);
  assert.match(portal, /<span>\{tag\}<\/span>/);
  assert.doesNotMatch(portal, /<span>\[\{tag\}\]<\/span>/);
  assert.match(portal, />\{visibleTags\.join\(" "\)\}<\/span><PostTitleText/);
  assert.doesNotMatch(portal, /visibleTags\.map\(\(tag\) => `\[\$\{tag\}\]\`\)/);
  assert.equal((portal.match(/<CommunityTagPicker /g) ?? []).length, 2, "새 글과 글 수정 화면에 각각 선택기가 있어야 한다");
  assert.ok((portal.match(/<CommunityPostTitle /g) ?? []).length >= 4, "목록·상세·미리보기·마이페이지에서 머릿글을 표시해야 한다");
  assert.match(styles, /\.community-tag-option input:checked\+span\s*\{[^}]*background:#111;[^}]*color:#fff;/);
  assert.match(styles, /\.community-title-tags\s*\{[^}]*color:#111;/);
  assert.match(styles, /\.community-tag-option span\s*\{[^}]*min-width:48px;[^}]*height:26px;[^}]*font-size:12px;[^}]*font-weight:600;/);
  assert.match(styles, /@media[^]*\.community-tag-options\s*\{[^}]*grid-template-columns:repeat\(5,minmax\(0,1fr\)\)/);
  assert.match(styles, /@media[^]*\.community-tag-option span\s*\{[^}]*height:28px;[^}]*font-size:12px;[^}]*font-weight:600;/);
});
