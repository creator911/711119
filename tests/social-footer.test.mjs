import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

test("footer social buttons use provided icons and external links", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  const styles = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(portal, /https:\/\/www\.instagram\.com\/care_nara_\//);
  assert.match(portal, /https:\/\/x\.com\/care_nara_/);
  assert.match(portal, /aria-label="텔레그램 링크 준비 중"/);
  assert.match(styles, /\.socials a,\.socials button\s*\{[\s\S]*?width:46px;[\s\S]*?height:46px;[\s\S]*?\}/);
  assert.match(styles, /background-image:url\("\/social\/instagram\.png"\)/);
  assert.match(styles, /background-image:url\("\/social\/telegram\.png"\)/);
  assert.match(styles, /background-image:url\("\/social\/x\.png"\)/);

  await access(new URL("../public/social/instagram.png", import.meta.url));
  await access(new URL("../public/social/telegram.png", import.meta.url));
  await access(new URL("../public/social/x.png", import.meta.url));
});
