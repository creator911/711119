import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("모든 게시글 제목 입력칸은 안내문과 입력 글자를 수직 중앙에 배치한다", async () => {
  const [globalStyles, adminStyles] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
  ]);
  assert.match(globalStyles, /\.forum-title-input \{[^}]*height:40px;[^}]*line-height:38px;/);
  assert.match(globalStyles, /\.rich-title-editable \{[^}]*height:40px;[^}]*line-height:38px;/);
  assert.match(globalStyles, /\.rich-title-editable\[data-empty="true"\]::before \{[^}]*line-height:38px;/);
  assert.match(globalStyles, /\.vendor-title-input \{[^}]*font:13px\/42px inherit;/);
  assert.match(adminStyles, /\.admin-editor-field>span \{[^}]*margin-bottom:7px;/);
});
