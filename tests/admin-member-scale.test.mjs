import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ADMIN_MEMBER_PREFIX_WHERE_SQL, adminMemberPrefixSearch } from "../app/lib/admin-member-search.ts";

const medianDuration = (statement, bindings, iterations = 9) => {
  statement.all(...bindings);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    statement.all(...bindings);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
};

const planDetails = (database, sql, bindings = []) => database
  .prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...bindings)
  .map(({ detail }) => String(detail));

test("100k admin member sorts and prefix search use the existing indexes", async () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL UNIQUE,
        points INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        is_director INTEGER NOT NULL DEFAULT 0,
        is_partner INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );
      WITH RECURSIVE sequence(value) AS (
        VALUES(0)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 99999
      )
      INSERT INTO users(username,nickname,points,level,is_director,is_partner,created_at)
      SELECT
        printf('user-%06d', value),
        printf('nick-%06d', value),
        value % 10000,
        value % 10 + 1,
        CASE WHEN value % 101 = 0 THEN 1 ELSE 0 END,
        CASE WHEN value % 503 = 0 THEN 1 ELSE 0 END,
        printf('%06d', value)
      FROM sequence;
    `);
    for (const migrationName of ["0034_green_wonder_man.sql", "0035_moaning_zemo.sql"]) {
      const migration = await readFile(new URL(`../drizzle/${migrationName}`, import.meta.url), "utf8");
      for (const statement of migration.split(/-->\s*statement-breakpoint/).map((value) => value.trim()).filter(Boolean)) database.exec(statement);
    }

    const sortPlans = new Map([
      ["created_at DESC,id DESC", "users_created_id_idx"],
      ["points DESC,id DESC", "users_points_id_idx"],
      ["level DESC,id DESC", "users_level_id_idx"],
      ["username COLLATE NOCASE ASC,id ASC", "users_username_nocase_id_idx"],
      ["nickname COLLATE NOCASE ASC,id ASC", "users_nickname_nocase_id_idx"],
      ["is_director DESC,created_at DESC,id DESC", "users_director_created_id_idx"],
      ["is_partner DESC,created_at DESC,id DESC", "users_partner_created_id_idx"],
    ]);
    for (const [orderBy, expectedIndex] of sortPlans) {
      const plan = planDetails(database, `SELECT id FROM users ORDER BY ${orderBy} LIMIT ? OFFSET ?`, [1000, 50000]);
      assert.ok(plan.some((detail) => detail.includes(expectedIndex)), `${orderBy} must use ${expectedIndex}: ${plan.join(" | ")}`);
      assert.ok(!plan.some((detail) => detail.includes("TEMP B-TREE")), `${orderBy} must not sort into a temporary B-tree`);
    }

    const search = adminMemberPrefixSearch("user-099999");
    assert.ok(search);
    const countSql = `SELECT COUNT(*) AS count FROM users WHERE ${ADMIN_MEMBER_PREFIX_WHERE_SQL}`;
    const listSql = `SELECT id,username,nickname FROM users WHERE ${ADMIN_MEMBER_PREFIX_WHERE_SQL} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`;
    for (const [sql, bindings] of [[countSql, [search.pattern, search.pattern]], [listSql, [search.pattern, search.pattern, 10, 0]]]) {
      const plan = planDetails(database, sql, bindings);
      assert.ok(plan.some((detail) => detail.includes("users_username_nocase_id_idx")), plan.join(" | "));
      assert.ok(plan.some((detail) => detail.includes("users_nickname_nocase_id_idx")), plan.join(" | "));
      assert.ok(!plan.some((detail) => /^SCAN users(?:\s|$)/.test(detail)), plan.join(" | "));
    }

    const optimized = medianDuration(database.prepare(countSql), [search.pattern, search.pattern]);
    const legacySql = "SELECT COUNT(*) AS count FROM users WHERE LOWER(username) LIKE ? ESCAPE '!' OR LOWER(nickname) LIKE ? ESCAPE '!'";
    const legacy = medianDuration(database.prepare(legacySql), [`%${search.query.toLowerCase()}%`, `%${search.query.toLowerCase()}%`]);
    assert.ok(optimized * 10 < legacy, `indexed prefix median ${optimized.toFixed(3)}ms should be materially below legacy scan ${legacy.toFixed(3)}ms`);

    const deepPageSql = "SELECT id FROM users ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?";
    const deepPage = medianDuration(database.prepare(deepPageSql), [10, 99990]);
    console.log(`100k admin query benchmark: prefix=${optimized.toFixed(3)}ms legacy-scan=${legacy.toFixed(3)}ms deep-page=${deepPage.toFixed(3)}ms`);
  } finally {
    database.close();
  }
});
