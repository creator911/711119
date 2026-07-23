import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(path, import.meta.url), "utf8");

test("회원과 관리자 고객센터 답글은 같은 이미지 첨부기를 사용한다", async () => {
  const [portal, admin, composer, uploadClient] = await Promise.all([
    read("../app/components/Portal.tsx"),
    read("../app/admin/AdminSupport.tsx"),
    read("../app/components/SupportReplyComposer.tsx"),
    read("../app/lib/client-media-upload.ts"),
  ]);
  assert.match(portal, /<SupportReplyComposer key=\{inquiry\.id\}/);
  assert.match(admin, /<SupportReplyComposer[\s\S]*variant="admin"/);
  assert.match(composer, /const MAX_IMAGES = 4/);
  assert.match(composer, /onDragEnter=\{dragEnter\}/);
  assert.match(composer, /onDrop=\{drop\}/);
  assert.match(composer, /uploadMediaFile\(optimized, \{ signal: controller\.signal, admin: variant === "admin" \}\)/);
  assert.match(uploadClient, /"X-Upload-Context": "admin"/);
  assert.match(composer, /accept="image\/jpeg,image\/png,image\/gif,image\/webp,image\/avif,image\/bmp"/);
});

test("고객센터 미디어는 문의 소유자와 관리자에게만 제공한다", async () => {
  const [protectedRoute, publicRoute, memberReply, adminReply] = await Promise.all([
    read("../app/api/support/media/[key]/route.ts"),
    read("../app/api/media/[key]/route.ts"),
    read("../app/api/support/[id]/route.ts"),
    read("../app/api/admin/support/[id]/route.ts"),
  ]);
  assert.match(protectedRoute, /i\.user_id=\?/);
  assert.match(protectedRoute, /adminSession/);
  assert.match(protectedRoute, /Cache-Control", "private/);
  assert.match(publicRoute, /resource_type='support'/);
  assert.match(publicRoute, /resource_type!='support'/);
  for (const route of [memberReply, adminReply]) {
    assert.match(route, /imageCount > 4/);
    assert.match(route, /supportReplyMediaFinalizeStatements/);
    assert.match(route, /rollbackBodyMedia/);
  }
});
