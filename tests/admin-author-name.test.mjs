import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("admin notice editor accepts and stores a custom author name", async () => {
  const [consoleSource, noticeRoute, eventRoute, overviewRoute, postListQuery] = await Promise.all([
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/posts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/events/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/overview/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/post-list-query.ts", import.meta.url), "utf8"),
  ]);
  assert.match(consoleSource, /name="authorName"/);
  assert.match(consoleSource, /authorName: String\(data\.get\("authorName"\)/);
  assert.match(consoleSource, /className="admin-editor-field"/);
  assert.doesNotMatch(consoleSource, /<label>\{mode === "events" \? "이벤트 제목"[\s\S]*?<RichTitleInput/);
  assert.match(noticeRoute, /author_name/);
  assert.match(eventRoute, /author_name/);
  assert.match(overviewRoute, /COALESCE\(NULLIF\(p\.author_name,''\),u\.nickname,'운영자'\) AS author/);
  assert.match(postListQuery, /COALESCE\(NULLIF\(p\.author_name,''\),u\.nickname,'운영자'\) AS author/);
});
