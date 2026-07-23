import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { buildPostListQuery } from "../app/lib/post-list-query.ts";
import {
  comparePopularPosts,
  isInPopularWindow,
  popularCutoffIso,
  POPULAR_POST_WINDOW_MS,
} from "../app/lib/popular-posts.ts";

const now = Date.parse("2026-07-21T12:00:00.000Z");

test("인기글은 추천-비추천 점수를 가장 먼저 비교한다", () => {
  const posts = [
    { id: 1, likes: 8, dislikes: 6, views: 9999, createdAt: "2026-07-21T11:00:00.000Z" },
    { id: 2, likes: 5, dislikes: 2, views: 10, createdAt: "2026-07-20T11:00:00.000Z" },
  ].sort(comparePopularPosts);
  assert.deepEqual(posts.map(({ id }) => id), [2, 1]);
});

test("추천 점수가 같으면 조회수, 작성일, 게시글 번호 순으로 비교한다", () => {
  const posts = [
    { id: 1, likes: 5, dislikes: 1, views: 50, createdAt: "2026-07-21T10:00:00.000Z" },
    { id: 2, likes: 9, dislikes: 5, views: 80, createdAt: "2026-07-20T10:00:00.000Z" },
    { id: 3, likes: 6, dislikes: 2, views: 80, createdAt: "2026-07-21T09:00:00.000Z" },
    { id: 4, likes: 8, dislikes: 4, views: 80, createdAt: "2026-07-21T09:00:00.000Z" },
  ].sort(comparePopularPosts);
  assert.deepEqual(posts.map(({ id }) => id), [4, 3, 2, 1]);
});

test("인기글 기간은 최근 7일 경계를 포함하고 미래 글과 기간 초과 글은 제외한다", () => {
  assert.equal(isInPopularWindow({ createdAt: new Date(now).toISOString() }, now), true);
  assert.equal(isInPopularWindow({ createdAt: new Date(now - POPULAR_POST_WINDOW_MS).toISOString() }, now), true);
  assert.equal(isInPopularWindow({ createdAt: new Date(now - POPULAR_POST_WINDOW_MS - 1).toISOString() }, now), false);
  assert.equal(isInPopularWindow({ createdAt: new Date(now + 1).toISOString() }, now), false);
  assert.equal(isInPopularWindow({}, now), false);
  assert.equal(popularCutoffIso(now), "2026-07-14T12:00:00.000Z");
});

test("게시글 API 쿼리는 최근 7일 실제 후보만 정렬해 최대 100개를 반환한다", () => {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, nickname TEXT, level INTEGER);
    CREATE TABLE posts (
      id INTEGER PRIMARY KEY, category TEXT NOT NULL, title TEXT NOT NULL, title_color TEXT NOT NULL DEFAULT '', body TEXT NOT NULL,
      author_id INTEGER NOT NULL, author_name TEXT NOT NULL DEFAULT '', views INTEGER NOT NULL, likes INTEGER NOT NULL, dislikes INTEGER NOT NULL,
      report_count INTEGER NOT NULL, is_notice INTEGER NOT NULL, is_pinned INTEGER NOT NULL,
      community_tag_mask INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE post_comments (id INTEGER PRIMARY KEY, post_id INTEGER NOT NULL, status TEXT NOT NULL);
    CREATE TABLE post_stats (post_id INTEGER PRIMARY KEY, comment_count INTEGER NOT NULL DEFAULT 0);
  `);
  const insert = database.prepare(`
    INSERT INTO posts(id,category,title,body,author_id,views,likes,dislikes,report_count,is_notice,is_pinned,status,created_at)
    VALUES(?,?,?,'본문',0,?,?,?,?,0,0,'published',?)
  `);
  const iso = (offset) => new Date(now + offset).toISOString();
  insert.run(1, "community", "점수 우선", 10, 7, 4, 0, iso(-3 * 60 * 60 * 1000));
  insert.run(2, "community", "조회가 많아도 점수 후순위", 999, 4, 2, 0, iso(-2 * 60 * 60 * 1000));
  insert.run(3, "gifs", "동점 조회 우선", 20, 8, 5, 0, iso(-2 * 60 * 60 * 1000));
  insert.run(4, "community", "동점 최신 우선", 20, 6, 3, 0, iso(-1 * 60 * 60 * 1000));
  insert.run(5, "community", "8일 전 제외", 5000, 100, 0, 0, iso(-8 * 24 * 60 * 60 * 1000));
  insert.run(6, "community", "미래 글 제외", 5000, 100, 0, 0, iso(1));
  for (let id = 10; id < 115; id += 1) insert.run(id, "community", `일반 글 ${id}`, 0, 0, 0, 0, iso(-4 * 60 * 60 * 1000 - id));

  const { sql, bindings } = buildPostListQuery("community", "popular", new Date(now));
  const rows = database.prepare(sql).all(...bindings);
  assert.equal(rows.length, 100);
  assert.deepEqual(rows.slice(0, 4).map(({ id }) => id), [4, 3, 1, 2]);
  assert.equal(rows.some(({ id }) => id === 5 || id === 6), false);
  database.close();
});
