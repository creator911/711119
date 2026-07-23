import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  maybePruneStalePreparedContent,
  publishCommentWithReward,
  publishPostWithReward,
} from "../app/lib/content-rewards.ts";

class LocalStatement {
  constructor(database, query, values = []) {
    this.database = database;
    this.query = query;
    this.values = values;
  }

  bind(...values) {
    return new LocalStatement(this.database, this.query, values);
  }

  async first() {
    return this.database.prepare(this.query).get(...this.values) ?? null;
  }

  async all() {
    return { results: this.database.prepare(this.query).all(...this.values) };
  }
}

class LocalD1 {
  constructor(database) {
    this.database = database;
  }

  prepare(query) {
    return new LocalStatement(this.database, query);
  }

  async batch(statements) {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => {
        const result = this.database.prepare(statement.query).run(...statement.values);
        return { meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

class AmbiguousCommitD1 extends LocalD1 {
  constructor(database) {
    super(database);
    this.throwAfterNextCommit = true;
  }

  async batch(statements) {
    const results = await super.batch(statements);
    if (this.throwAfterNextCommit) {
      this.throwAfterNextCommit = false;
      throw new Error("injected lost response after commit");
    }
    return results;
  }
}

function fixture() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`
    CREATE TABLE users(id INTEGER PRIMARY KEY,points INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL);
    CREATE TABLE posts(id INTEGER PRIMARY KEY,category TEXT NOT NULL,author_id INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT '2026-07-25T00:00:00.000Z');
    CREATE TABLE post_comments(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL,user_id INTEGER NOT NULL,status TEXT NOT NULL,created_at TEXT NOT NULL DEFAULT '2026-07-25T00:00:00.000Z');
    CREATE TABLE post_polls(id INTEGER PRIMARY KEY,post_id INTEGER NOT NULL);
    CREATE TABLE post_poll_options(id INTEGER PRIMARY KEY,poll_id INTEGER NOT NULL);
    CREATE TABLE post_poll_votes(id INTEGER PRIMARY KEY,poll_id INTEGER NOT NULL);
    CREATE TABLE point_ledger(
      id INTEGER PRIMARY KEY AUTOINCREMENT,user_id INTEGER NOT NULL,amount INTEGER NOT NULL,
      type TEXT NOT NULL,status TEXT NOT NULL,reference TEXT,created_at TEXT NOT NULL
    );
    CREATE UNIQUE INDEX point_ledger_content_reward_user_reference_unique
      ON point_ledger(user_id,type,reference)
      WHERE type IN ('post_create','review_create','comment_create') AND reference IS NOT NULL;
    CREATE INDEX posts_draft_created_id_idx ON posts(created_at,id) WHERE status='draft';
    CREATE INDEX post_comments_pending_created_id_idx ON post_comments(created_at,id) WHERE status='pending';
    CREATE TABLE publication_audit(resource TEXT NOT NULL,resource_id INTEGER NOT NULL);
    CREATE TRIGGER test_post_publication AFTER UPDATE OF status ON posts
      WHEN OLD.status<>'published' AND NEW.status='published'
      BEGIN INSERT INTO publication_audit VALUES('post',NEW.id); END;
    CREATE TRIGGER test_comment_publication AFTER UPDATE OF status ON post_comments
      WHEN OLD.status<>'published' AND NEW.status='published'
      BEGIN INSERT INTO publication_audit VALUES('comment',NEW.id); END;
    INSERT INTO users(id,points,status) VALUES(1,0,'active'),(2,0,'suspended');
    INSERT INTO posts(id,category,author_id,status) VALUES(11,'community',1,'draft'),(12,'reviews',1,'draft'),(13,'community',2,'draft');
    INSERT INTO post_comments(id,post_id,user_id,status) VALUES(21,11,1,'pending'),(22,11,2,'pending');
  `);
  return { sqlite, database: new LocalD1(sqlite) };
}

test("post publication and configured reward commit atomically and replay without double credit", async () => {
  const { sqlite, database } = fixture();
  try {
    sqlite.exec(`
      CREATE TRIGGER reject_post_reward BEFORE INSERT ON point_ledger
      WHEN NEW.type='post_create' BEGIN SELECT RAISE(ABORT,'injected reward failure'); END;
    `);
    await assert.rejects(() => publishPostWithReward(database, {
      postId: 11, authorId: 1, category: "community", points: 10, createdAt: "2026-07-23T00:00:00.000Z",
    }), /injected reward failure/);
    assert.equal(sqlite.prepare("SELECT status FROM posts WHERE id=11").get().status, "draft");
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger").get().count, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM publication_audit").get().count, 0);

    sqlite.exec("DROP TRIGGER reject_post_reward");
    const first = await publishPostWithReward(database, {
      postId: 11, authorId: 1, category: "community", points: 10, createdAt: "2026-07-23T00:00:00.000Z",
    });
    const replay = await publishPostWithReward(database, {
      postId: 11, authorId: 1, category: "community", points: 10, createdAt: "2026-07-23T00:00:00.000Z",
    });
    assert.deepEqual(first, { earnedPoints: 10, reference: "community:11" });
    assert.deepEqual(replay, first);
    assert.equal(sqlite.prepare("SELECT status FROM posts WHERE id=11").get().status, "published");
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 10);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE reference='community:11'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM publication_audit WHERE resource='post' AND resource_id=11").get().count, 1);
  } finally {
    sqlite.close();
  }
});

test("comment publication and reward are atomic, idempotent, and require an active member", async () => {
  const { sqlite, database } = fixture();
  try {
    sqlite.exec("UPDATE posts SET status='published' WHERE id=11");
    const first = await publishCommentWithReward(database, {
      commentId: 21, postId: 11, authorId: 1, points: 5, createdAt: "2026-07-23T00:01:00.000Z",
    });
    const replay = await publishCommentWithReward(database, {
      commentId: 21, postId: 11, authorId: 1, points: 5, createdAt: "2026-07-23T00:01:00.000Z",
    });
    assert.deepEqual(first, { earnedPoints: 5, reference: "post:11:comment:21" });
    assert.deepEqual(replay, first);
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 5);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE reference='post:11:comment:21'").get().count, 1);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM publication_audit WHERE resource='comment' AND resource_id=21").get().count, 1);

    await assert.rejects(() => publishCommentWithReward(database, {
      commentId: 22, postId: 11, authorId: 2, points: 5, createdAt: "2026-07-23T00:02:00.000Z",
    }), /comment_publish_reward_not_committed/);
    assert.equal(sqlite.prepare("SELECT status FROM post_comments WHERE id=22").get().status, "pending");
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=2").get().points, 0);

    sqlite.exec("INSERT INTO post_comments(id,post_id,user_id,status) VALUES(23,999,1,'pending')");
    await assert.rejects(() => publishCommentWithReward(database, {
      commentId: 23, postId: 999, authorId: 1, points: 5, createdAt: "2026-07-23T00:03:00.000Z",
    }), /comment_publish_reward_not_committed/);
    assert.equal(sqlite.prepare("SELECT status FROM post_comments WHERE id=23").get().status, "pending");
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 5);
  } finally {
    sqlite.close();
  }
});

test("zero-point configuration publishes without creating a ledger row", async () => {
  const { sqlite, database } = fixture();
  try {
    const result = await publishPostWithReward(database, {
      postId: 12, authorId: 1, category: "reviews", points: 0, createdAt: "2026-07-23T00:03:00.000Z",
    });
    assert.deepEqual(result, { earnedPoints: 0, reference: null });
    assert.equal(sqlite.prepare("SELECT status FROM posts WHERE id=12").get().status, "published");
    assert.equal(sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 0);
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger").get().count, 0);

    sqlite.exec(`
      INSERT INTO post_comments(id,post_id,user_id,status) VALUES
        (24,999,1,'pending'),(25,12,1,'pending');
    `);
    await assert.rejects(() => publishCommentWithReward(database, {
      commentId: 24, postId: 999, authorId: 1, points: 0, createdAt: "2026-07-23T00:04:00.000Z",
    }), /comment_publish_reward_not_committed/);
    assert.equal(sqlite.prepare("SELECT status FROM post_comments WHERE id=24").get().status, "pending");
    assert.deepEqual(await publishCommentWithReward(database, {
      commentId: 25, postId: 12, authorId: 1, points: 0, createdAt: "2026-07-23T00:04:01.000Z",
    }), { earnedPoints: 0, reference: null });
    assert.equal(sqlite.prepare("SELECT status FROM post_comments WHERE id=25").get().status, "published");
  } finally {
    sqlite.close();
  }
});

test("a lost D1 response after commit is recovered from durable state without duplicate credit", async () => {
  const postFixture = fixture();
  try {
    const ambiguousDatabase = new AmbiguousCommitD1(postFixture.sqlite);
    const published = await publishPostWithReward(ambiguousDatabase, {
      postId: 11, authorId: 1, category: "community", points: 10, createdAt: "2026-07-23T00:05:00.000Z",
    });
    assert.deepEqual(published, { earnedPoints: 10, reference: "community:11" });
    assert.equal(postFixture.sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 10);
    assert.equal(postFixture.sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE reference='community:11'").get().count, 1);
  } finally {
    postFixture.sqlite.close();
  }

  const commentFixture = fixture();
  try {
    commentFixture.sqlite.exec("UPDATE posts SET status='published' WHERE id=11");
    const ambiguousDatabase = new AmbiguousCommitD1(commentFixture.sqlite);
    const published = await publishCommentWithReward(ambiguousDatabase, {
      commentId: 21, postId: 11, authorId: 1, points: 5, createdAt: "2026-07-23T00:06:00.000Z",
    });
    assert.deepEqual(published, { earnedPoints: 5, reference: "post:11:comment:21" });
    assert.equal(commentFixture.sqlite.prepare("SELECT points FROM users WHERE id=1").get().points, 5);
    assert.equal(commentFixture.sqlite.prepare("SELECT COUNT(*) AS count FROM point_ledger WHERE reference='post:11:comment:21'").get().count, 1);
  } finally {
    commentFixture.sqlite.close();
  }
});

test("bounded indexed cleanup removes only stale invisible crash remnants", async () => {
  const { sqlite, database } = fixture();
  try {
    sqlite.exec(`
      INSERT INTO posts(id,category,author_id,status,created_at) VALUES
        (31,'community',1,'draft','2026-07-20T00:00:00.000Z'),
        (32,'community',1,'draft','2026-07-25T00:00:00.000Z'),
        (33,'community',1,'published','2026-07-20T00:00:00.000Z');
      INSERT INTO post_polls VALUES(41,31),(42,32);
      INSERT INTO post_poll_options VALUES(51,41),(52,42);
      INSERT INTO post_poll_votes VALUES(61,41),(62,42);
      INSERT INTO post_comments(id,post_id,user_id,status,created_at) VALUES
        (71,33,1,'pending','2026-07-20T00:00:00.000Z'),
        (72,33,1,'pending','2026-07-25T00:00:00.000Z'),
        (73,33,1,'published','2026-07-20T00:00:00.000Z');
    `);
    assert.deepEqual(await maybePruneStalePreparedContent(database, 63, Date.parse("2026-07-25T12:00:00.000Z")), {
      ran: false, posts: 0, comments: 0,
    });
    assert.deepEqual(await maybePruneStalePreparedContent(database, 64, Date.parse("2026-07-25T12:00:00.000Z")), {
      ran: true, posts: 1, comments: 1,
    });
    assert.deepEqual(sqlite.prepare("SELECT id FROM posts WHERE id BETWEEN 31 AND 33 ORDER BY id").all().map(({ id }) => id), [32, 33]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM post_comments WHERE id BETWEEN 71 AND 73 ORDER BY id").all().map(({ id }) => id), [72, 73]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM post_polls ORDER BY id").all().map(({ id }) => id), [42]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM post_poll_options ORDER BY id").all().map(({ id }) => id), [52]);
    assert.deepEqual(sqlite.prepare("SELECT id FROM post_poll_votes ORDER BY id").all().map(({ id }) => id), [62]);

    const postPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN SELECT id FROM posts
      WHERE status='draft' AND created_at<? ORDER BY created_at,id LIMIT ?
    `).all("2026-07-24T12:00:00.000Z", 64).map(({ detail }) => String(detail));
    const commentPlan = sqlite.prepare(`
      EXPLAIN QUERY PLAN SELECT id FROM post_comments
      WHERE status='pending' AND created_at<? ORDER BY created_at,id LIMIT ?
    `).all("2026-07-24T12:00:00.000Z", 64).map(({ detail }) => String(detail));
    assert.ok(postPlan.some((detail) => detail.includes("posts_draft_created_id_idx")), postPlan.join("\n"));
    assert.ok(commentPlan.some((detail) => detail.includes("post_comments_pending_created_id_idx")), commentPlan.join("\n"));
    assert.ok(!postPlan.some((detail) => detail.includes("TEMP B-TREE")));
    assert.ok(!commentPlan.some((detail) => detail.includes("TEMP B-TREE")));
  } finally {
    sqlite.close();
  }
});

test("member-facing routes prepare invisible rows before the atomic publication batch", async () => {
  const { readFile } = await import("node:fs/promises");
  const [postsRoute, commentsRoute, helper] = await Promise.all([
    readFile(new URL("../app/api/posts/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/posts/[id]/comments/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/lib/content-rewards.ts", import.meta.url), "utf8"),
  ]);
  assert.match(postsRoute, /'draft'/);
  assert.match(postsRoute, /publishPostWithReward\(env\.DB/);
  assert.match(postsRoute, /afterPublishStatements: bodyMediaFinalizeStatements\(env\.DB/);
  assert.match(postsRoute, /maybePruneStalePreparedContent\(env\.DB, postId\)/);
  const failedPostCleanup = postsRoute.slice(postsRoute.indexOf("if (!saveCommitted && createdPostId)"));
  assert.match(failedPostCleanup, /DELETE FROM post_poll_votes[\s\S]*?p\.status='draft'/);
  assert.match(failedPostCleanup, /DELETE FROM post_poll_options[\s\S]*?p\.status='draft'/);
  assert.match(failedPostCleanup, /DELETE FROM post_polls[\s\S]*?status='draft'/);
  assert.match(failedPostCleanup, /DELETE FROM posts WHERE id=\? AND status='draft'/);
  assert.match(commentsRoute, /'pending'/);
  assert.match(commentsRoute, /publishCommentWithReward\(env\.DB/);
  assert.match(commentsRoute, /maybePruneStalePreparedContent\(env\.DB, commentId\)/);
  assert.match(helper, /database\.batch\(statements\)/);
  assert.match(helper, /status='draft'/);
  assert.match(helper, /status='pending'/);
  assert.match(helper, /INSERT OR IGNORE INTO point_ledger/);
});
