import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("vendor board omits bodies from list responses and uses an id-backed keyset cursor", async () => {
  const source = await readFile(new URL("../app/api/vendor-posts/route.ts", import.meta.url), "utf8");
  assert.match(source, /'' AS body/);
  assert.match(source, /WITH cursor_row AS/);
  assert.match(source, /vp\.id<cursor\.id/);
  assert.match(source, /page\.at\(-1\)\?\.id/);
  assert.doesNotMatch(source, /LIMIT 31 OFFSET/);
});

test("PostgreSQL vendor search and feed cursor have dedicated indexes", async () => {
  const source = await readFile(new URL("../server/postgres/migrate-from-sqlite.mjs", import.meta.url), "utf8");
  assert.match(source, /vendor_posts_search_trgm_idx/);
  assert.match(source, /vendor_posts_feed_cursor_idx/);
  assert.match(source, /gin_trgm_ops/);
});
