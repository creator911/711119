import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { openD1Database } from "../server/d1-sqlite.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDirectory = await mkdtemp(path.join(tmpdir(), "nara-level-progress-"));
const databasePath = path.join(testDirectory, "test.sqlite");
const port = 3116;
const env = { ...process.env, NARA_DB_PATH: databasePath, NARA_R2_DIR: path.join(testDirectory, "r2") };

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], { cwd: root, env: { ...env, ...extraEnv }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed with status ${result.status}`);
}

run("server/migrate.mjs");
const database = openD1Database(databasePath);
try {
  const now = new Date().toISOString();
  await database.prepare(`
    INSERT INTO users(username,nickname,password_hash,password_salt,signup_ip,points,level,level_locked,role,status,created_at)
    VALUES('progress-member','진행회원','hash','salt','192.0.2.44',0,1,0,'member','active',?)
  `).bind(now).run();
  const user = await database.prepare("SELECT id FROM users WHERE username='progress-member'").first();
  await database.prepare("INSERT INTO sessions(token,user_id,ip,expires_at,created_at) VALUES(?,?,?,?,?)")
    .bind("level-progress-session", user.id, "192.0.2.44", "2099-12-31T00:00:00.000Z", now).run();
  const hiddenPost = await database.prepare(`
    INSERT INTO posts(category,title,author_id,status,created_at) VALUES('community','hidden',?,'deleted',?)
  `).bind(user.id, now).run();
  const hiddenPostId = Number(hiddenPost.meta.last_row_id);
  await database.batch(Array.from({ length: 50 }, (_, index) => database.prepare(`
    INSERT INTO post_comments(post_id,user_id,body,status,created_at) VALUES(?,?,?,'published',?)
  `).bind(hiddenPostId, user.id, `comment ${index + 1}`, new Date(Date.now() + index).toISOString())));
  const settings = {
    postCreatePoints: 10,
    reviewCreatePoints: 50,
    commentCreatePoints: 5,
    attendanceBasePoints: 55,
    attendanceLevelStepPoints: 15,
    levelRequirements: [
      { level: 2, attendance: 6, posts: 7, comments: 12 },
      { level: 3, attendance: 30, posts: 20, comments: 50 },
      { level: 4, attendance: 100, posts: 50, comments: 100 },
      { level: 5, attendance: 150, posts: 100, comments: 300 },
    ],
    eventRewards: {
      weekly: { posts: [10000, 5000, 1000], comments: [10000, 5000, 1000] },
      monthly: { posts: [10000, 5000, 1000], comments: [10000, 5000, 1000] },
    },
  };
  await database.prepare("INSERT INTO site_settings(key,value,updated_by,updated_at) VALUES('point_system',?,'integration',?)").bind(JSON.stringify(settings), now).run();
} finally {
  database.close();
}

const server = spawn(process.execPath, [
  "--import", "./server/register-cloudflare-loader.mjs",
  "./node_modules/vinext/dist/cli.js", "start",
  "--hostname", "127.0.0.1", "--port", String(port),
], { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
let serverOutput = "";
server.stdout.on("data", (chunk) => { serverOutput += chunk; });
server.stderr.on("data", (chunk) => { serverOutput += chunk; });

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`);
      if (response.ok) { ready = true; break; }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error(`Test server did not start.\n${serverOutput}`);
  run("tests/member-level-progress-integration.mjs", {
    TEST_BASE_URL: `http://127.0.0.1:${port}`,
    TEST_DB_PATH: databasePath,
  });
} finally {
  server.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => server.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 2_000)),
  ]);
  if (server.exitCode === null) server.kill("SIGKILL");
  await rm(testDirectory, { recursive: true, force: true });
}
