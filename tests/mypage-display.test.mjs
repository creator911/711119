import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("마이페이지 내역은 5개부터 시작해 더보기마다 10개씩 펼쳐진다", async () => {
  const [portal, styles] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(portal, /visiblePostCount, setVisiblePostCount] = useState\(5\)/);
  assert.match(portal, /visiblePointCount, setVisiblePointCount] = useState\(5\)/);
  assert.match(portal, /posts\.slice\(0, visiblePostCount\)/);
  assert.match(portal, /pointHistory\.slice\(0, visiblePointCount\)/);
  assert.match(portal, /setVisiblePostCount\(\(count\) => count \+ 10\)/);
  assert.match(portal, /setVisiblePointCount\(\(count\) => count \+ 10\)/);
  assert.doesNotMatch(portal, /최소 1만P 이상 모이셨을때/);
  assert.match(styles, /\.mypage-post-list button \{[^}]*min-height:48px/);
  assert.match(styles, /\.point-history-list>div \{[^}]*min-height:48px/);
  assert.match(styles, /\.mypage-more \{/);
});
