import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("public post permissions ignore admin cookies when a member session is present", async () => {
  const [postRoute, vendorListRoute, vendorDetailRoute] = await Promise.all([
    readFile(new URL("../app/api/posts/[id]/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vendor-posts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/vendor-posts/[id]/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(postRoute, /const isStandaloneAdminActor = \(viewer: MemberSession \| null, operator: unknown\) => !viewer && Boolean\(operator\)/);
  assert.match(postRoute, /const adminActor = isStandaloneAdminActor\(viewer, operator\)/);
  assert.doesNotMatch(postRoute, /const adminActor = Boolean\(operator\)/);
  assert.doesNotMatch(postRoute, /publicPost\(id, viewer, Boolean\(operator\)\)/);

  assert.match(vendorListRoute, /const isStandaloneAdminActor = \(viewer: MemberSession \| null, operator: unknown\) => !viewer && Boolean\(operator\)/);
  assert.match(vendorListRoute, /decorate\(post, viewer, adminActor\)/);
  assert.doesNotMatch(vendorListRoute, /decorate\(post, viewer, Boolean\(operator\)\)/);

  assert.match(vendorDetailRoute, /const isStandaloneAdminActor = \(viewer: MemberSession \| null, operator: unknown\) => !viewer && Boolean\(operator\)/);
  assert.match(vendorDetailRoute, /const adminActor = isStandaloneAdminActor\(viewer, operator\)/);
  assert.doesNotMatch(vendorDetailRoute, /const adminActor = Boolean\(operator\)/);
});
