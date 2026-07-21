import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("모바일 제목 색상 선택기는 원형 팔레트와 색상 버튼을 한 줄에 표시한다", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(styles, /@media \(max-width:760px\)[^]*\.rich-title-toolbar\s*\{[^}]*display:grid;[^}]*grid-template-columns:auto repeat\(7,minmax\(24px,1fr\)\) minmax\(48px,1\.5fr\);/);
  assert.match(styles, /@media \(max-width:760px\)[^]*\.rich-title-toolbar button,\.rich-title-toolbar label\s*\{[^}]*font-size:0;/);
  assert.match(styles, /@media \(max-width:760px\)[^]*\.rich-title-toolbar label::after\s*\{[^}]*content:"색상";[^}]*font-size:10px;/);
});
