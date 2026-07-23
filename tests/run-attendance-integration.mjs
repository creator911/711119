import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const testDirectory = await mkdtemp(path.join(tmpdir(), "nara-attendance-"));
const port = 3120;
const env = {
  ...process.env,
  NARA_DB_PATH: path.join(testDirectory, "test.sqlite"),
  NARA_MEDIA_DIR: path.join(testDirectory, "media"),
  CAPTCHA_SECRET: "attendance-integration-captcha-secret-2026",
  ADMIN_SESSION_SECRET: "attendance-integration-session-secret-2026",
};

function run(script, extraEnv = {}) {
  const result = spawnSync(process.execPath, [script], { cwd: root, env: { ...env, ...extraEnv }, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`${script} failed with status ${result.status}`);
}

run("server/migrate.mjs");
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
  run("tests/attendance-integration.mjs", {
    TEST_BASE_URL: `http://127.0.0.1:${port}`,
    TEST_DB_PATH: env.NARA_DB_PATH,
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
