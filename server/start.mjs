import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  createWindowsProxyServer,
  findAvailableLoopbackPort,
  parseStartOptions,
  withoutBindArguments,
} from "./windows-production-start.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const vinextCli = path.join(root, "node_modules", "vinext", "dist", "cli.js");
const loader = path.join(root, "server", "register-cloudflare-loader.mjs");
const rawArguments = process.argv.slice(2);
const options = parseStartOptions(rawArguments);

async function runVinextInThisProcess() {
  process.argv = [process.execPath, vinextCli, "start", ...rawArguments];
  await import(pathToFileURL(vinextCli).href);
}

if (process.platform !== "win32" || options.help) {
  // Linux production keeps vinext's native server path and has no compatibility proxy.
  await runVinextInThisProcess();
} else {
  const internalPort = await findAvailableLoopbackPort();
  const server = createWindowsProxyServer({
    clientDirectory: path.join(root, "dist", "client"),
    internalPort,
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, resolve);
  });
  const child = spawn(process.execPath, [
    "--import", pathToFileURL(loader).href,
    vinextCli,
    "start",
    ...withoutBindArguments(rawArguments),
    "--hostname", "127.0.0.1",
    "--port", String(internalPort),
  ], {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    windowsHide: true,
  });
  console.log(`  nara001 start  (Windows static compatibility, port ${options.port})\n`);

  let stopping = false;
  const closeServer = () => {
    server.close();
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  };
  const stop = (signal = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    closeServer();
    if (child.exitCode === null) child.kill(signal);
  };
  process.once("SIGINT", () => stop("SIGINT"));
  process.once("SIGTERM", () => stop("SIGTERM"));
  process.once("SIGHUP", () => stop("SIGHUP"));

  await new Promise((resolve, reject) => {
    child.once("error", (error) => {
      closeServer();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      closeServer();
      if (!stopping && code !== 0) {
        reject(new Error(`vinext exited unexpectedly (${signal ?? code}).`));
        return;
      }
      resolve();
    });
  });
}
