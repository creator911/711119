import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main search and verification panels use calm blue accents and member level badge is white", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(styles, /--sky:#5aafef/);
  assert.match(styles, /\.search button\s*\{[\s\S]*?var\(--sky\)[\s\S]*?\}/);
  assert.match(styles, /\.hero-vendor-search button\s*\{[\s\S]*?var\(--sky\)[\s\S]*?\}/);
  assert.match(styles, /\.quick-trust\s*\{[\s\S]*?var\(--sky\)[\s\S]*?color:#fff;[\s\S]*?\}/);
  assert.match(styles, /\.quick-trust small\s*\{[\s\S]*?rgba\(255,255,255,\.86\)[\s\S]*?\}/);
  assert.match(styles, /\.member-level\s*\{[\s\S]*?background:#fff;[\s\S]*?color:#111;[\s\S]*?\}/);
});

test("포인트 상점 링크는 출석내역과 어울리는 흰색 파란 테두리 버튼이다", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(styles, /\.point-shop-link\s*\{[^}]*min-width:108px;[^}]*height:36px;[^}]*border:1px solid #cfe8fb!important;[^}]*background:#fff!important;[^}]*padding:0 14px!important;[^}]*box-shadow:0 5px 14px rgba\(90,175,239,\.14\)!important;/);
  assert.match(styles, /\.quick-strip button\.done\s*\{[^}]*border-color:#cfe8fb;[^}]*background:#fff;/);
});
