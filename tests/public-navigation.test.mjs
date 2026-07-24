import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  buildPublicUrl,
  parsePublicLocation,
  PUBLIC_VIEW_PATHS,
} from "../app/lib/public-navigation.ts";

test("모든 공개 대메뉴는 독립된 주소를 가진다", () => {
  assert.deepEqual(PUBLIC_VIEW_PATHS, {
    home: "/",
    notices: "/notices",
    vendors: "/vendors",
    community: "/community",
    reviews: "/reviews",
    events: "/events",
    partner: "/partner",
    support: "/support",
    mypage: "/mypage",
    shop: "/shop",
  });
  assert.equal(buildPublicUrl("community", { page: 1 }), "/community?page=1");
  assert.equal(buildPublicUrl("reviews", { page: 2 }), "/reviews?page=2");
  assert.equal(buildPublicUrl("mypage"), "/mypage");
  assert.equal(buildPublicUrl("shop"), "/shop");
});

test("게시글·업체·문의 상세 주소는 현재 페이지와 함께 복원된다", () => {
  assert.equal(buildPublicUrl("community", { page: 3, postId: 52 }), "/community?page=3&post=52");
  assert.equal(buildPublicUrl("vendors", { page: 2, featuredSlot: 4 }), "/vendors?page=2&featured=4");
  assert.equal(buildPublicUrl("vendors", { page: 2, vendorPostId: 91 }), "/vendors?page=2&vendorPost=91");
  assert.equal(buildPublicUrl("support", { page: 4, inquiryId: 17 }), "/support?page=4&inquiry=17");
});

test("경로와 쿼리를 화면 상태로 안전하게 해석한다", () => {
  assert.deepEqual(parsePublicLocation("/Community/", "?page=2&post=9"), {
    view: "community",
    page: 2,
    postId: 9,
    featuredSlot: null,
    vendorPostId: null,
    inquiryId: null,
  });
  assert.equal(parsePublicLocation("//reviews", "?page=-1").page, 1);
  assert.equal(parsePublicLocation("/", "?board=gifs&post=3").view, "community");
  assert.equal(parsePublicLocation("/unknown", "").view, "home");
});

test("직접 접속을 위한 공개 라우트 페이지를 모두 제공한다", async () => {
  for (const view of ["notices", "vendors", "community", "reviews", "events", "partner", "support", "mypage", "shop"]) {
    const source = await readFile(new URL(`../app/${view}/page.tsx`, import.meta.url), "utf8");
    assert.match(source, new RegExp(`initialView="${view}"`));
  }
});

test("포털은 실제 history와 popstate로 주소와 화면을 동기화한다", async () => {
  const portal = await readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8");
  assert.match(portal, /window\.history\[replace \? "replaceState" : "pushState"\]/);
  assert.match(portal, /window\.addEventListener\("popstate", syncFromBrowser\)/);
  assert.match(portal, /buildPublicUrl\(item\.key, \{ page: 1 \}\)/);
  assert.doesNotMatch(portal, /\?board=\$\{/);
});
