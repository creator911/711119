import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import {
  ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL,
  adminSupportPrefixSearch,
  adminSupportSearchBindings,
} from "../app/lib/admin-support-search.ts";

const countSql = `${ADMIN_SUPPORT_MATCHED_IDS_CTE_SQL} SELECT COUNT(*) AS count FROM matched_ids`;

const planDetails = (database, sql, bindings) => database
  .prepare(`EXPLAIN QUERY PLAN ${sql}`)
  .all(...bindings)
  .map(({ detail }) => String(detail));

const medianDuration = (statement, bindings, iterations = 7) => {
  statement.get(...bindings);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    const startedAt = performance.now();
    statement.get(...bindings);
    samples.push(performance.now() - startedAt);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)];
};

test("100k+ 문의 검색은 임의 최신 구간 없이 세 prefix index를 사용한다", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL UNIQUE
      );
      CREATE TABLE support_inquiries (
        id INTEGER PRIMARY KEY,
        user_id INTEGER NOT NULL,
        kind TEXT NOT NULL,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        staff_unread INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX users_username_nocase_id_idx ON users(username COLLATE NOCASE,id);
      CREATE INDEX users_nickname_nocase_id_idx ON users(nickname COLLATE NOCASE,id);
      CREATE INDEX support_inquiries_member_kind_id_idx ON support_inquiries(user_id,kind,id);
      CREATE INDEX support_inquiries_admin_title_nocase_idx
        ON support_inquiries(kind,title COLLATE NOCASE,id) WHERE status != 'deleted';

      WITH RECURSIVE sequence(value) AS (
        VALUES(0)
        UNION ALL
        SELECT value + 1 FROM sequence WHERE value < 100499
      )
      INSERT INTO users(id,username,nickname)
      SELECT value + 1,printf('user-%06d',value),printf('nick-%06d',value) FROM sequence;

      INSERT INTO support_inquiries(id,user_id,kind,title,status,staff_unread,updated_at)
      SELECT id,id,CASE WHEN id % 2 = 1 THEN 'support' ELSE 'partner' END,
             printf('문의-%06d',id - 1),'open',id % 3,printf('%06d',id)
      FROM users;

      UPDATE users SET username='literal%_!member',nickname='literal%_!nickname' WHERE id=100499;
      UPDATE support_inquiries SET title='literal%_!title' WHERE id=100499;
    `);

    const titleSearch = adminSupportPrefixSearch("문의-099998");
    const usernameSearch = adminSupportPrefixSearch("USER-099998");
    const nicknameSearch = adminSupportPrefixSearch("nick-099998");
    assert.ok(titleSearch && usernameSearch && nicknameSearch);
    for (const search of [titleSearch, usernameSearch, nicknameSearch]) {
      const bindings = adminSupportSearchBindings("support", search.pattern);
      assert.equal(database.prepare(countSql).get(...bindings).count, 1);
      const plan = planDetails(database, countSql, bindings);
      for (const indexName of [
        "support_inquiries_admin_title_nocase_idx",
        "users_username_nocase_id_idx",
        "users_nickname_nocase_id_idx",
        "support_inquiries_member_kind_id_idx",
      ]) assert.ok(plan.some((detail) => detail.includes(indexName)), `${indexName}: ${plan.join(" | ")}`);
      assert.ok(!plan.some((detail) => /^SCAN (?:i|u)(?:\s|$)/.test(detail)), plan.join(" | "));
    }

    const literalSearch = adminSupportPrefixSearch("literal%_!");
    assert.ok(literalSearch);
    assert.equal(literalSearch.pattern, "literal!%!_!!%");
    assert.equal(database.prepare(countSql).get(...adminSupportSearchBindings("support", literalSearch.pattern)).count, 1);
    const substring = adminSupportPrefixSearch("ser-099998");
    assert.ok(substring);
    assert.equal(database.prepare(countSql).get(...adminSupportSearchBindings("support", substring.pattern)).count, 0);
    assert.equal(adminSupportPrefixSearch("가".repeat(27)), null);
    assert.ok(adminSupportPrefixSearch("a".repeat(80)));
    assert.equal(adminSupportPrefixSearch("a".repeat(81)), null);

    const optimizedStatement = database.prepare(countSql);
    const optimizedBindings = adminSupportSearchBindings("support", usernameSearch.pattern);
    const optimized = medianDuration(optimizedStatement, optimizedBindings);
    const legacyStatement = database.prepare(`
      SELECT COUNT(*) AS count
      FROM support_inquiries i JOIN users u ON u.id=i.user_id
      WHERE i.kind='support' AND i.status != 'deleted'
        AND (i.title LIKE ? OR u.username LIKE ? OR u.nickname LIKE ?)
    `);
    const legacy = medianDuration(legacyStatement, ["%099998%", "%099998%", "%099998%"]);
    assert.ok(optimized * 5 < legacy, `indexed=${optimized.toFixed(3)}ms legacy-scan=${legacy.toFixed(3)}ms`);
    console.log(`100k+ support prefix benchmark: indexed=${optimized.toFixed(3)}ms legacy-scan=${legacy.toFixed(3)}ms`);
  } finally {
    database.close();
  }
});
