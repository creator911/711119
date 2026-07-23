import { existsSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { openD1Database } from "../../server/d1-sqlite.mjs";
import { applyMigrations } from "../../server/migrate.mjs";

if (process.env.SCALE_FIXTURE_CONFIRM !== "1") {
  throw new Error("Set SCALE_FIXTURE_CONFIRM=1 to generate the disposable scale database");
}

const databasePath = path.resolve(process.env.SCALE_FIXTURE_DB || ".nara-data/scale/nara001-scale.sqlite");
const userCount = Math.max(1, Number(process.env.SCALE_USERS || 100_000));
const postCount = Math.max(1, Number(process.env.SCALE_POSTS || 1_000_000));
const commentCount = Math.max(1, Number(process.env.SCALE_COMMENTS || 3_000_000));
const chunkSize = 10_000;

if (/[/\\]var[/\\]lib[/\\]nara001/i.test(databasePath)) throw new Error("Refusing to seed a production-style data path");
if (existsSync(databasePath)) {
  if (process.env.SCALE_FIXTURE_RESET !== "1") throw new Error("Scale database exists; set SCALE_FIXTURE_RESET=1 to recreate it");
  rmSync(databasePath);
}
mkdirSync(path.dirname(databasePath), { recursive: true });

const database = openD1Database(databasePath, { synchronous: "OFF" });
applyMigrations(database);
const triggerRows = database._allSync("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND sql IS NOT NULL");
for (const trigger of triggerRows) database._execSync(`DROP TRIGGER ${JSON.stringify(trigger.name)}`);

function chunks(total, action) {
  for (let start = 1; start <= total; start += chunkSize) action(start, Math.min(total, start + chunkSize - 1));
}

database._transaction(() => {
  chunks(userCount, (start, end) => database._runSync(`
    WITH RECURSIVE seq(value) AS (
      SELECT ? UNION ALL SELECT value+1 FROM seq WHERE value<?
    )
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,is_director,is_partner,role,status,created_at)
    SELECT 'scale_user_'||value,'테스트회원'||value,'x','x','10.0.'||(value/255)||'.'||(value%255),0,1,0,0,0,'member','active','2026-01-01T00:00:00.000Z'
    FROM seq
  `, [start, end]));
  chunks(postCount, (start, end) => database._runSync(`
    WITH RECURSIVE seq(value) AS (
      SELECT ? UNION ALL SELECT value+1 FROM seq WHERE value<?
    )
    INSERT INTO posts(category,title,title_color,body,author_id,author_name,views,likes,dislikes,report_count,is_notice,is_pinned,community_tag_mask,status,created_at)
    SELECT CASE value%4 WHEN 0 THEN 'reviews' WHEN 1 THEN 'community' WHEN 2 THEN 'events' ELSE 'notices' END,
           '규모 검증 게시글 '||value,'','<p>규모 검증 본문입니다.</p>',((value-1)%?)+1,'',
           value%1000,value%50,value%5,0,0,0,4,'published','2026-07-01T00:00:00.000Z'
    FROM seq
  `, [start, end, userCount]));
  chunks(commentCount, (start, end) => database._runSync(`
    WITH RECURSIVE seq(value) AS (
      SELECT ? UNION ALL SELECT value+1 FROM seq WHERE value<?
    )
    INSERT INTO post_comments(post_id,user_id,body,status,created_at)
    SELECT ((value-1)%?)+1,((value-1)%?)+1,'규모 검증 댓글 '||value,'published','2026-07-01T00:00:00.000Z'
    FROM seq
  `, [start, end, postCount, userCount]));
});

database._execSync("DELETE FROM member_activity_stats");
database._execSync(`
  INSERT INTO member_activity_stats(user_id,attendance_count,post_count,comment_count,updated_at)
  SELECT u.id,0,COALESCE(p.count,0),COALESCE(c.count,0),'2026-07-01T00:00:00.000Z'
  FROM users u
  LEFT JOIN (SELECT author_id AS user_id,COUNT(*) AS count FROM posts WHERE status='published' GROUP BY author_id) p ON p.user_id=u.id
  LEFT JOIN (SELECT user_id,COUNT(*) AS count FROM post_comments WHERE status='published' GROUP BY user_id) c ON c.user_id=u.id
`);
database._execSync("DELETE FROM post_stats");
database._execSync(`
  INSERT INTO post_stats(post_id,comment_count,updated_at)
  SELECT p.id,COALESCE(c.count,0),'2026-07-01T00:00:00.000Z'
  FROM posts p
  LEFT JOIN (SELECT post_id,COUNT(*) AS count FROM post_comments WHERE status='published' GROUP BY post_id) c ON c.post_id=p.id
`);
for (const trigger of triggerRows) database._execSync(trigger.sql);
database._execSync("ANALYZE");
database.close();
console.log(JSON.stringify({ databasePath, userCount, postCount, commentCount }));
