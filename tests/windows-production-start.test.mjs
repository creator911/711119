import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseStartOptions, withoutBindArguments } from "../server/windows-production-start.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

test("Windows production start argument handling preserves non-bind flags", () => {
  assert.deepEqual(parseStartOptions(["--hostname", "127.0.0.1", "--port=3127"]), {
    help: false,
    host: "127.0.0.1",
    port: 3127,
  });
  assert.deepEqual(
    withoutBindArguments(["--hostname", "127.0.0.1", "--port=3127", "--verbose"]),
    ["--verbose"],
  );
});

test("package start uses the project-owned production entrypoint", async () => {
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.match(packageJson.scripts.start, /server\/start\.mjs/);
  assert.match(packageJson.scripts.start, /register-cloudflare-loader\.mjs/);
});

test("Windows production start serves SSR, CSS, JavaScript, and API responses", {
  skip: process.platform !== "win32",
  timeout: 45_000,
}, async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [
    "--import", "./server/register-cloudflare-loader.mjs",
    "./server/start.mjs",
    "--hostname", "127.0.0.1",
    "--port", String(port),
  ], {
    cwd: root,
    env: {
      ...process.env,
      ADMIN_SESSION_SECRET: "a".repeat(40),
      CAPTCHA_SECRET: "c".repeat(40),
      NODE_ENV: "production",
    },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let output = "";
  child.stdout.on("data", (chunk) => { output += chunk; });
  child.stderr.on("data", (chunk) => { output += chunk; });

  try {
    let homepage;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`);
        if (response.ok) {
          homepage = await response.text();
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    assert.ok(homepage, `production server did not become ready:\n${output}`);

    const assetUrls = [...homepage.matchAll(/(?:href|src)="(\/assets\/[^"?]+\.(?:css|js))[^" ]*"/g)]
      .map((match) => match[1]);
    const cssUrl = assetUrls.find((url) => url.endsWith(".css"));
    const scriptUrl = assetUrls.find((url) => url.endsWith(".js"));
    assert.ok(cssUrl, "SSR HTML must reference a CSS asset");
    assert.ok(scriptUrl, "SSR HTML must reference a JavaScript asset");

    for (const assetUrl of [cssUrl, scriptUrl]) {
      const response = await fetch(`http://127.0.0.1:${port}${assetUrl}`);
      assert.equal(response.status, 200, `${assetUrl} should be served`);
      assert.match(response.headers.get("cache-control") ?? "", /immutable/);
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }

    const apiResponse = await fetch(`http://127.0.0.1:${port}/api/captcha`);
    assert.equal(apiResponse.status, 200);
    assert.match(apiResponse.headers.get("content-type") ?? "", /image\/svg\+xml/);
  } finally {
    const exited = child.exitCode === null
      ? new Promise((resolve) => child.once("exit", resolve))
      : Promise.resolve();
    if (child.exitCode === null) child.kill("SIGTERM");
    let exitTimeout;
    await Promise.race([
      exited,
      new Promise((resolve) => { exitTimeout = setTimeout(resolve, 3_000); }),
    ]);
    clearTimeout(exitTimeout);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
