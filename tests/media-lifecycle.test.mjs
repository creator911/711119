import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  bodyMediaFinalizeStatements,
  bodyMediaReleaseStatements,
  bodyMediaKeys,
  discardPendingMedia,
  finalizeBodyMedia,
  MediaOwnershipError,
  PENDING_MEDIA_TTL_MS,
  prunePendingMedia,
  recordPendingMedia,
  releaseBodyMediaReferences,
  reserveBodyMedia,
  rollbackBodyMedia,
} from "../app/lib/media-lifecycle.ts";

function asyncDatabase(database) {
  const api = {
    prepare(query) {
      const statement = database.prepare(query);
      return {
        bind(...values) {
          const bound = {
            _statement: statement,
            _values: values,
            async first() { return statement.get(...values) ?? null; },
            async all() { return { results: statement.all(...values) }; },
            async run() {
              const result = statement.run(...values);
              return { meta: { changes: Number(result.changes) } };
            },
          };
          return bound;
        },
      };
    },
    async batch(statements) {
      database.exec("BEGIN");
      try {
        const results = [];
        for (const statement of statements) results.push(await statement.run());
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
  return api;
}

function mediaDatabase() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE uploaded_media (
      key TEXT PRIMARY KEY NOT NULL,
      owner_key TEXT NOT NULL,
      media_type TEXT NOT NULL,
      content_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL,
      attached_at TEXT,
      claim_token TEXT,
      claimed_at TEXT,
      CHECK(status IN ('pending','attaching','attached','pruning'))
    );
    CREATE INDEX uploaded_media_status_created_idx ON uploaded_media(status,created_at);
    CREATE TABLE uploaded_media_references (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      media_key TEXT NOT NULL REFERENCES uploaded_media(key) ON DELETE CASCADE,
      resource_type TEXT NOT NULL,
      resource_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(media_key,resource_type,resource_id)
    );
    CREATE TABLE posts (id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published');
    CREATE TABLE vendor_posts (id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'published');
    CREATE TABLE support_inquiries (id INTEGER PRIMARY KEY, body TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open');
    CREATE TABLE featured_vendor_posts (slot INTEGER PRIMARY KEY, body TEXT NOT NULL, cover_key TEXT);
  `);
  return { sqlite, database: asyncDatabase(sqlite) };
}

const firstKey = "11111111-1111-4111-8111-111111111111.jpg";
const secondKey = "22222222-2222-4222-8222-222222222222.mp4";

test("정규화 본문의 이미지와 동영상 키만 첨부 대상으로 추출한다", () => {
  const keys = bodyMediaKeys(`
    <a href="/api/media/${firstKey}">링크</a>
    <img src="/api/media/${firstKey}" />
    <video controls="controls" src="/api/media/${secondKey}"></video>
    <img src="https://example.com/not-local.jpg" />
  `);
  assert.deepEqual(keys, [firstKey, secondKey]);
});

test("pending 미디어는 업로더만 예약할 수 있고 저장 성공 뒤 attached가 된다", async () => {
  const { sqlite, database } = mediaDatabase();
  await recordPendingMedia(database, {
    key: firstKey,
    ownerKey: "member:1",
    mediaType: "image",
    contentType: "image/jpeg",
    sizeBytes: 100,
  });
  const body = `<div class="editor-media-block"><img src="/api/media/${firstKey}" /></div>`;

  await assert.rejects(() => reserveBodyMedia(database, "member:2", body), MediaOwnershipError);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");

  const firstClaim = await reserveBodyMedia(database, "member:1", body);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attaching");
  await rollbackBodyMedia(database, firstClaim);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");

  const secondClaim = await reserveBodyMedia(database, "member:1", body);
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(body);
  await finalizeBodyMedia(database, secondClaim, "post", 1, body, "2026-07-20T12:00:00.000Z");
  const attached = sqlite.prepare("SELECT status,attached_at AS attachedAt FROM uploaded_media WHERE key=?").get(firstKey);
  assert.equal(attached.status, "attached");
  assert.equal(attached.attachedAt, "2026-07-20T12:00:00.000Z");

  // A new post cannot copy another user's attached object.
  await assert.rejects(() => reserveBodyMedia(database, "admin:owner:dow", body), MediaOwnershipError);
  // An administrator editing the existing target may preserve its already-attached object.
  const adminClaim = await reserveBodyMedia(database, "admin:owner:dow", body, body);
  assert.deepEqual(adminClaim.keys, []);
  assert.equal(sqlite.prepare("SELECT owner_key AS ownerKey FROM uploaded_media WHERE key=?").get(firstKey).ownerKey, "member:1");
  sqlite.close();
});

test("지연 정리는 오래된 pending만 제한적으로 삭제하고 attached는 절대 삭제하지 않는다", async () => {
  const { sqlite, database } = mediaDatabase();
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const old = new Date(now - PENDING_MEDIA_TTL_MS - 1).toISOString();
  const fresh = new Date(now - 1_000).toISOString();
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/jpeg", 10, "pending", old, null, null, null);
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(secondKey, "member:1", "video", "video/mp4", 10, "attached", old, old, null, null);
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(`<video src="/api/media/${secondKey}"></video>`);
  sqlite.prepare("INSERT INTO uploaded_media_references(media_key,resource_type,resource_id,created_at) VALUES(?,?,?,?)").run(secondKey, "post", "1", old);
  const freshKey = "33333333-3333-4333-8333-333333333333.png";
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(freshKey, "member:1", "image", "image/png", 10, "pending", fresh, null, null, null);
  const deletedKeys = [];
  const bucket = { async delete(key) { deletedKeys.push(key); } };

  assert.equal(await prunePendingMedia(database, bucket, now), 1);
  assert.deepEqual(deletedKeys, [firstKey]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media WHERE key=?").get(firstKey).count, 0);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(secondKey).status, "attached");
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(freshKey).status, "pending");
  sqlite.close();
});

test("stale attaching은 저장된 본문 참조를 복구하고 미참조 객체만 정리한다", async () => {
  const { sqlite, database } = mediaDatabase();
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const old = new Date(now - PENDING_MEDIA_TTL_MS - 1).toISOString();
  const usedBody = `<img src="/api/media/${firstKey}" />`;
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(usedBody);
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/jpeg", 10, "attaching", old, null, "claim-used", old);
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(secondKey, "member:1", "video", "video/mp4", 10, "attaching", old, null, "claim-unused", old);
  const pruningKey = "44444444-4444-4444-8444-444444444444.webp";
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(pruningKey, "member:1", "image", "image/webp", 10, "pruning", old, null, null, old);
  const deleted = [];

  assert.equal(await prunePendingMedia(database, { async delete(key) { deleted.push(key); } }, now), 2);
  assert.deepEqual(deleted, [secondKey, pruningKey]);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attached");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media_references WHERE media_key=? AND resource_type='post' AND resource_id='1'").get(firstKey).count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media WHERE key=?").get(secondKey).count, 0);
  sqlite.close();
});

test("본문에 없는 featured cover의 stale attaching도 cover_key로 attached 복구한다", async () => {
  const { sqlite, database } = mediaDatabase();
  const now = Date.parse("2026-07-20T12:00:00.000Z");
  const old = new Date(now - PENDING_MEDIA_TTL_MS - 1).toISOString();
  sqlite.prepare("INSERT INTO featured_vendor_posts(slot,body,cover_key) VALUES(1,'소개 본문',?)").run(firstKey);
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/webp", 10, "attaching", old, null, "cover-claim", old);
  const deleted = [];

  assert.equal(await prunePendingMedia(database, { async delete(key) { deleted.push(key); } }, now), 0);
  assert.deepEqual(deleted, []);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attached");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media_references WHERE media_key=? AND resource_type='featured' AND resource_id='1'").get(firstKey).count, 1);
  sqlite.close();
});

test("본문 제거와 글 삭제는 마지막 참조를 pending으로 돌린 뒤 TTL 후 정리한다", async () => {
  const { sqlite, database } = mediaDatabase();
  const attachedAt = "2026-07-20T12:00:00.000Z";
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/jpeg", 10, "attached", attachedAt, attachedAt, null, null);
  sqlite.prepare("INSERT INTO uploaded_media_references(media_key,resource_type,resource_id,created_at) VALUES(?,?,?,?)").run(firstKey, "post", "1", attachedAt);
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,'삭제된 본문','deleted')").run();

  await releaseBodyMediaReferences(database, "post", 1, attachedAt);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");
  const deleted = [];
  assert.equal(await prunePendingMedia(database, { async delete(key) { deleted.push(key); } }, Date.parse(attachedAt) + PENDING_MEDIA_TTL_MS - 1), 0);
  assert.equal(await prunePendingMedia(database, { async delete(key) { deleted.push(key); } }, Date.parse(attachedAt) + PENDING_MEDIA_TTL_MS + 1), 1);
  assert.deepEqual(deleted, [firstKey]);
  sqlite.close();
});

test("본문·투표·미디어 참조 update batch 실패는 모두 원상복구된다", async () => {
  const { sqlite, database } = mediaDatabase();
  sqlite.exec("CREATE TABLE post_polls(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL); INSERT INTO post_polls VALUES(1,1); CREATE TABLE fail_guard(value INTEGER CHECK(value=0));");
  const oldBody = "기존 본문";
  const nextBody = `<img src="/api/media/${firstKey}" />`;
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(oldBody);
  await recordPendingMedia(database, { key: firstKey, ownerKey: "member:1", mediaType: "image", contentType: "image/jpeg", sizeBytes: 10 });
  const claim = await reserveBodyMedia(database, "member:1", nextBody, oldBody);

  await assert.rejects(() => database.batch([
    database.prepare("DELETE FROM post_polls WHERE post_id=?").bind(1),
    database.prepare("UPDATE posts SET body=? WHERE id=?").bind(nextBody, 1),
    ...bodyMediaFinalizeStatements(database, claim, "post", 1, nextBody),
    database.prepare("INSERT INTO fail_guard(value) VALUES(?)").bind(1),
  ]));
  assert.equal(sqlite.prepare("SELECT body FROM posts WHERE id=1").get().body, oldBody);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM post_polls WHERE post_id=1").get().count, 1);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media_references").get().count, 0);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attaching");
  await rollbackBodyMedia(database, claim);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");
  sqlite.close();
});

test("동시 본문 수정의 last-write-wins 뒤 이전 요청 미디어는 bounded orphan sweep으로 회수된다", async () => {
  const { sqlite, database } = mediaDatabase();
  const oldBody = "기존 본문";
  const firstBody = `<img src="/api/media/${firstKey}" />`;
  const secondBody = `<video src="/api/media/${secondKey}"></video>`;
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(oldBody);
  await recordPendingMedia(database, { key: firstKey, ownerKey: "member:1", mediaType: "image", contentType: "image/jpeg", sizeBytes: 10 });
  await recordPendingMedia(database, { key: secondKey, ownerKey: "member:1", mediaType: "video", contentType: "video/mp4", sizeBytes: 10 });
  const firstClaim = await reserveBodyMedia(database, "member:1", firstBody, oldBody);
  const secondClaim = await reserveBodyMedia(database, "member:1", secondBody, oldBody);

  await database.batch([
    database.prepare("UPDATE posts SET body=? WHERE id=1").bind(firstBody),
    ...bodyMediaFinalizeStatements(database, firstClaim, "post", 1, firstBody),
  ]);
  await database.batch([
    database.prepare("UPDATE posts SET body=? WHERE id=1").bind(secondBody),
    ...bodyMediaFinalizeStatements(database, secondClaim, "post", 1, secondBody),
  ]);

  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(secondKey).status, "attached");
  assert.deepEqual(
    sqlite.prepare("SELECT media_key AS mediaKey FROM uploaded_media_references ORDER BY media_key").all().map(({ mediaKey }) => mediaKey),
    [secondKey],
  );
  sqlite.close();
});

test("삭제 cleanup 준비 뒤 동시 첨부가 생겨도 delete batch가 새 orphan까지 회수한다", async () => {
  const { sqlite, database } = mediaDatabase();
  const oldBody = `<img src="/api/media/${firstKey}" />`;
  const nextBody = `<video src="/api/media/${secondKey}"></video>`;
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(oldBody);
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/jpeg", 10, "attached", "2026-07-20T00:00:00.000Z", "2026-07-20T00:00:00.000Z", null, null);
  sqlite.prepare("INSERT INTO uploaded_media_references(media_key,resource_type,resource_id,created_at) VALUES(?,?,?,?)").run(firstKey, "post", "1", "2026-07-20T00:00:00.000Z");
  await recordPendingMedia(database, { key: secondKey, ownerKey: "member:1", mediaType: "video", contentType: "video/mp4", sizeBytes: 10 });

  const deleteCleanup = await bodyMediaReleaseStatements(database, "post", 1, "2026-07-20T12:00:00.000Z");
  const concurrentClaim = await reserveBodyMedia(database, "member:1", nextBody, oldBody);
  await database.batch([
    database.prepare("UPDATE posts SET body=? WHERE id=1").bind(nextBody),
    ...bodyMediaFinalizeStatements(database, concurrentClaim, "post", 1, nextBody),
  ]);
  await database.batch([
    database.prepare("UPDATE posts SET status='deleted' WHERE id=1 AND status='published'").bind(),
    ...deleteCleanup,
  ]);

  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media_references").get().count, 0);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(secondKey).status, "pending");
  sqlite.close();
});

test("attached 키를 같은 소유자의 다른 글로 이동하는 동안 원글이 삭제돼도 새 참조를 보존한다", async () => {
  const { sqlite, database } = mediaDatabase();
  const body = `<img src="/api/media/${firstKey}" />`;
  const now = "2026-07-20T12:00:00.000Z";
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(1,?,'published')").run(body);
  sqlite.prepare("INSERT INTO posts(id,body,status) VALUES(2,'새 글','published')").run();
  sqlite.prepare("INSERT INTO uploaded_media VALUES(?,?,?,?,?,?,?,?,?,?)").run(firstKey, "member:1", "image", "image/jpeg", 10, "attached", now, now, null, null);
  sqlite.prepare("INSERT INTO uploaded_media_references(media_key,resource_type,resource_id,created_at) VALUES(?,?,?,?)").run(firstKey, "post", "1", now);

  const moveClaim = await reserveBodyMedia(database, "member:1", body, "새 글");
  assert.deepEqual(moveClaim.attachedKeys, [firstKey]);
  const sourceCleanup = await bodyMediaReleaseStatements(database, "post", 1, now);
  await database.batch([
    database.prepare("UPDATE posts SET status='deleted' WHERE id=1 AND status='published'").bind(),
    ...sourceCleanup,
  ]);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attaching");

  await database.batch([
    database.prepare("UPDATE posts SET body=? WHERE id=2").bind(body),
    ...bodyMediaFinalizeStatements(database, moveClaim, "post", 2, body, now),
  ]);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "attached");
  assert.deepEqual(
    sqlite.prepare("SELECT resource_id AS resourceId FROM uploaded_media_references WHERE media_key=?").all(firstKey).map(({ resourceId }) => resourceId),
    ["2"],
  );
  sqlite.close();
});

test("실패 업로드의 R2 삭제가 실패하면 metadata를 남겨 다음 정리에서 재시도한다", async () => {
  const { sqlite, database } = mediaDatabase();
  await recordPendingMedia(database, {
    key: firstKey,
    ownerKey: "member:1",
    mediaType: "image",
    contentType: "image/jpeg",
    sizeBytes: 100,
    createdAt: "2026-07-19T00:00:00.000Z",
  });
  await discardPendingMedia(database, { async delete() { throw new Error("R2 unavailable"); } }, firstKey);
  assert.equal(sqlite.prepare("SELECT status FROM uploaded_media WHERE key=?").get(firstKey).status, "pending");

  const deleted = [];
  await discardPendingMedia(database, { async delete(key) { deleted.push(key); } }, firstKey);
  assert.deepEqual(deleted, [firstKey]);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM uploaded_media").get().count, 0);
  sqlite.close();
});
