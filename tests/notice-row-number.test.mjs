import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("notice board rows prefer numeric row numbers over notice badges", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  assert.match(portal, /kind === "notices" \? totalPosts - pageStart - index/);
});
