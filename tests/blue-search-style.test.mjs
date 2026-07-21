import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("main search buttons use calm blue accent and member level badge is white", async () => {
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(styles, /--sky:#5aafef/);
  assert.match(styles, /\.search button\s*\{[\s\S]*?var\(--sky\)[\s\S]*?\}/);
  assert.match(styles, /\.hero-vendor-search button\s*\{[\s\S]*?var\(--sky\)[\s\S]*?\}/);
  assert.match(styles, /\.member-level\s*\{[\s\S]*?background:#fff;[\s\S]*?color:#111;[\s\S]*?\}/);
});
