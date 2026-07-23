import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { pipeline } from "node:stream";

const CONTENT_TYPES = new Map([
  [".avif", "image/avif"],
  [".css", "text/css; charset=utf-8"],
  [".eot", "application/vnd.ms-fontobject"],
  [".gif", "image/gif"],
  [".html", "text/html; charset=utf-8"],
  [".ico", "image/x-icon"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".mjs", "text/javascript; charset=utf-8"],
  [".mp4", "video/mp4"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".ttf", "font/ttf"],
  [".webm", "video/webm"],
  [".webp", "image/webp"],
  [".woff", "font/woff"],
  [".woff2", "font/woff2"],
]);

const parsePort = (raw, flag) => {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 0 || value > 65_535) {
    throw new Error(`${flag} expects a valid TCP port, but got "${raw}".`);
  }
  return value;
};

export function parseStartOptions(args, environment = process.env) {
  let host = "0.0.0.0";
  let port = parsePort(environment.PORT ?? "3000", "PORT");
  let help = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === "--help" || argument === "-h") {
      help = true;
    } else if (argument === "--port" || argument === "-p") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value.`);
      port = parsePort(value, argument);
      index += 1;
    } else if (argument.startsWith("--port=")) {
      port = parsePort(argument.slice("--port=".length), "--port");
    } else if (argument === "--hostname" || argument === "-H") {
      const value = args[index + 1];
      if (!value || value.startsWith("-")) throw new Error(`${argument} requires a value.`);
      host = value;
      index += 1;
    } else if (argument.startsWith("--hostname=")) {
      host = argument.slice("--hostname=".length);
      if (!host) throw new Error("--hostname requires a value.");
    }
  }

  return { help, host, port };
}
export function withoutBindArguments(args) {
  const output = [];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (["--port", "-p", "--hostname", "-H"].includes(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=") || argument.startsWith("--hostname=")) continue;
    output.push(argument);
  }
  return output;
}

function requestPathname(request) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname);
  } catch {
    return null;
  }
  return pathname.includes("\0") ? null : pathname;
}

function resolveClientFile(clientDirectory, pathname) {
  if (pathname === "/" || pathname === "/.vite" || pathname.startsWith("/.vite/")) return null;
  const candidate = path.resolve(clientDirectory, `.${pathname}`);
  const relative = path.relative(clientDirectory, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return candidate;
}

function weakEtag(fileStat) {
  return `W/"${fileStat.size}-${Math.floor(fileStat.mtimeMs / 1_000)}"`;
}

function matchesEtag(header, etag) {
  return typeof header === "string" && header.split(",").some((value) => {
    const candidate = value.trim();
    return candidate === "*" || candidate === etag;
  });
}

export function createClientStaticHandler(clientDirectory) {
  const root = path.resolve(clientDirectory);
  return async function serveClientStatic(request, response) {
    if (request.method !== "GET" && request.method !== "HEAD") return false;
    const pathname = requestPathname(request);
    if (pathname === null) {
      response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Bad Request");
      return true;
    }

    const filePath = resolveClientFile(root, pathname);
    if (!filePath) return false;

    let fileStat;
    try {
      fileStat = await stat(filePath);
    } catch (error) {
      if (error?.code === "ENOENT" || error?.code === "ENOTDIR") return false;
      throw error;
    }
    if (!fileStat.isFile()) return false;

    const etag = weakEtag(fileStat);
    const cacheControl = pathname.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "public, max-age=3600";
    if (matchesEtag(request.headers["if-none-match"], etag)) {
      response.writeHead(304, { ETag: etag, "Cache-Control": cacheControl });
      response.end();
      return true;
    }

    response.writeHead(200, {
      "Cache-Control": cacheControl,
      "Content-Length": String(fileStat.size),
      "Content-Type": CONTENT_TYPES.get(path.extname(filePath).toLowerCase()) ?? "application/octet-stream",
      ETag: etag,
      "Last-Modified": fileStat.mtime.toUTCString(),
      "X-Content-Type-Options": "nosniff",
    });
    if (request.method === "HEAD") {
      response.end();
      return true;
    }
    pipeline(createReadStream(filePath), response, (error) => {
      if (error && !response.destroyed) response.destroy(error);
    });
    return true;
  };
}

function proxyHttpRequest(request, response, internalPort, agent) {
  const upstream = http.request({
    agent,
    headers: request.headers,
    host: "127.0.0.1",
    method: request.method,
    path: request.url,
    port: internalPort,
  }, (upstreamResponse) => {
    response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
    upstreamResponse.pipe(response);
  });
  upstream.on("error", () => {
    if (response.headersSent) {
      response.destroy();
      return;
    }
    response.writeHead(503, {
      "Cache-Control": "no-store",
      "Content-Type": "text/plain; charset=utf-8",
      "Retry-After": "1",
    });
    response.end("Service is starting");
  });
  request.on("aborted", () => upstream.destroy());
  request.pipe(upstream);
}

function proxyUpgrade(request, socket, head, internalPort) {
  const upstream = net.connect(internalPort, "127.0.0.1", () => {
    const requestLine = `${request.method} ${request.url} HTTP/${request.httpVersion}\r\n`;
    const headers = request.rawHeaders.reduce((output, value, index) => {
      return output + (index % 2 === 0 ? value : `: ${value}\r\n`);
    }, "");
    upstream.write(`${requestLine}${headers}\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
}

export function createWindowsProxyServer({ clientDirectory, internalPort }) {
  const serveStatic = createClientStaticHandler(clientDirectory);
  const agent = new http.Agent({ keepAlive: true, maxSockets: 256 });
  const server = http.createServer(async (request, response) => {
    try {
      if (await serveStatic(request, response)) return;
      proxyHttpRequest(request, response, internalPort, agent);
    } catch {
      if (!response.headersSent) response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Internal Server Error");
    }
  });
  server.on("upgrade", (request, socket, head) => proxyUpgrade(request, socket, head, internalPort));
  server.on("close", () => agent.destroy());
  return server;
}

export async function findAvailableLoopbackPort() {
  const reservation = net.createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve, reject) => reservation.close((error) => error ? reject(error) : resolve()));
  if (!port) throw new Error("Could not reserve an internal vinext port.");
  return port;
}
