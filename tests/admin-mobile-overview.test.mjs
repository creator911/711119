import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("관리자 최신글은 모바일에서 카드형으로 표시되어 내부 가로 스크롤을 만들지 않는다", async () => {
  const [consoleSource, styles] = await Promise.all([
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
  ]);

  assert.match(consoleSource, /className="admin-table posts-table"/);
  assert.match(styles, /@media\(max-width:600px\)[\s\S]*?\.posts-table \{ overflow:visible; \}/);
  assert.match(styles, /\.posts-table \.admin-tr\.head \{ display:none; \}/);
  assert.match(styles, /\.posts-table \.admin-tr:not\(\.head\) \{ min-width:0;/);
  assert.match(styles, /content:"조회·추천 "/);
});
