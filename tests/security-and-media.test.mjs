import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ACCOUNT_BLOCK_MS,
  activeLoginFailure,
  IP_BLOCK_MS,
  recordPasswordFailure,
} from "../app/lib/admin-login-failures.ts";
import { hasRichMedia, normalizeRichBody } from "../app/lib/rich-text.ts";
import { pruneUploadQuota, releaseUploadQuota, reserveUploadQuota } from "../app/lib/upload-quota.ts";

function asyncDatabase(database) {
  return {
    prepare(query) {
      const statement = database.prepare(query);
      return {
        bind(...values) {
          return {
            async first() { return statement.get(...values) ?? null; },
            async run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
          };
        },
      };
    },
  };
}

test("잘못된 관리자 비밀번호는 계정과 IP 실패 횟수에 모두 반영된다", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE admin_ip_login_failures (ip TEXT PRIMARY KEY, failure_count INTEGER NOT NULL DEFAULT 0, blocked_until TEXT, updated_at TEXT NOT NULL);
    CREATE TABLE admin_account_login_failures (username TEXT PRIMARY KEY, failure_count INTEGER NOT NULL DEFAULT 0, blocked_until TEXT, updated_at TEXT NOT NULL);
  `);
  const database = asyncDatabase(sqlite);
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const ip = "198.51.100.80";

  for (let attempt = 0; attempt < 5; attempt += 1) await recordPasswordFailure(database, ip, "dow", now + attempt);
  assert.equal(sqlite.prepare("SELECT failure_count FROM admin_ip_login_failures WHERE ip=?").get(ip).failure_count, 5);
  const accountBlock = sqlite.prepare("SELECT failure_count,blocked_until FROM admin_account_login_failures WHERE username='dow'").get();
  assert.equal(accountBlock.failure_count, 5);
  assert.equal(Date.parse(accountBlock.blocked_until), now + 4 + ACCOUNT_BLOCK_MS);

  for (let attempt = 0; attempt < 5; attempt += 1) await recordPasswordFailure(database, ip, "pupu", now + 5 + attempt);
  const ipBlock = sqlite.prepare("SELECT failure_count,blocked_until FROM admin_ip_login_failures WHERE ip=?").get(ip);
  assert.equal(ipBlock.failure_count, 10);
  assert.equal(Date.parse(ipBlock.blocked_until), now + 9 + IP_BLOCK_MS);
  assert.ok((await activeLoginFailure(database, "admin_ip_login_failures", "ip", ip, now + 10))?.blocked_until);
  assert.equal(await activeLoginFailure(database, "admin_ip_login_failures", "ip", ip, now + 9 + IP_BLOCK_MS + 1), null);
  sqlite.close();
});

test("첨부 사용량은 한 시간 단위로 파일 수와 용량을 함께 제한한다", async () => {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE upload_usage (id TEXT PRIMARY KEY, actor_key TEXT NOT NULL, size_bytes INTEGER NOT NULL, created_at TEXT NOT NULL); CREATE INDEX upload_usage_actor_created_idx ON upload_usage(actor_key,created_at);");
  const database = asyncDatabase(sqlite);
  const limits = { files: 3, bytes: 10 };
  const now = Date.parse("2026-07-20T12:00:00.000Z");

  assert.equal(await reserveUploadQuota(database, "r1", "member:1", 4, limits, now), true);
  assert.equal(await reserveUploadQuota(database, "r2", "member:1", 4, limits, now + 1), true);
  assert.equal(await reserveUploadQuota(database, "r3", "member:1", 3, limits, now + 2), false);
  assert.equal(await reserveUploadQuota(database, "r4", "member:2", 10, limits, now + 3), true);
  await releaseUploadQuota(database, "r2");
  assert.equal(await reserveUploadQuota(database, "r5", "member:1", 6, limits, now + 4), true);
  assert.equal(await reserveUploadQuota(database, "r6", "member:1", 1, limits, now + 60 * 60 * 1000 + 5), true);
  await pruneUploadQuota(database, now + 4 * 60 * 60 * 1000);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM upload_usage").get().count, 0);
  sqlite.close();
});

test("안전한 YouTube iframe만 미디어 본문으로 인정한다", async () => {
  const safe = normalizeRichBody('<div class="editor-youtube-block"><iframe src="https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ" title="YouTube"></iframe></div>');
  assert.equal(safe.textLength, 0);
  assert.equal(hasRichMedia(safe.body), true);
  assert.match(safe.body, /youtube-nocookie\.com\/embed\/dQw4w9WgXcQ/);

  const unsafe = normalizeRichBody('<iframe src="https://example.com/unsafe"></iframe>');
  assert.equal(hasRichMedia(unsafe.body), false);
  assert.doesNotMatch(unsafe.body, /iframe|example\.com/);

  const externalUploadBypass = normalizeRichBody('<img src="https://example.com/tracker.gif"><video src="https://example.com/movie.mp4"></video>');
  assert.equal(hasRichMedia(externalUploadBypass.body), false);
  assert.doesNotMatch(externalUploadBypass.body, /img|video|example\.com/);
  const localUpload = normalizeRichBody('<img src="/api/media/11111111-1111-4111-8111-111111111111.gif">');
  assert.equal(hasRichMedia(localUpload.body), true);
  assert.match(localUpload.body, /\/api\/media\/11111111-1111-4111-8111-111111111111\.gif/);

  const validationRoutes = await Promise.all([
    "../app/api/posts/route.ts", "../app/api/posts/[id]/route.ts", "../app/api/admin/posts/route.ts",
    "../app/api/admin/events/route.ts", "../app/api/support/route.ts",
  ].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  for (const source of validationRoutes) assert.match(source, /hasRichMedia\(/);

  const uploadRoute = await readFile(new URL("../app/api/uploads/route.ts", import.meta.url), "utf8");
  assert.match(uploadRoute, /recordPendingMedia\(/);
  assert.match(uploadRoute, /prunePendingMedia\(/);
  assert.match(uploadRoute, /discardPendingMedia\(/);
  const featuredRoute = await readFile(new URL("../app/api/featured-vendors/[slot]/route.ts", import.meta.url), "utf8");
  assert.match(featuredRoute, /reserveUploadQuota\(/);
  assert.match(featuredRoute, /recordPendingMedia\(/);
  assert.match(featuredRoute, /bodyMediaFinalizeStatements\(/);
  assert.match(featuredRoute, /discardPendingMedia\(/);
});
