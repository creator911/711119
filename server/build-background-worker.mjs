import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("..", import.meta.url));
const workersBinding = path.join(root, "server", "cloudflare-workers.mjs");

await build({
  configFile: false,
  root,
  publicDir: false,
  logLevel: "warn",
  plugins: [{
    name: "nara-worker-bindings",
    enforce: "pre",
    resolveId(source) {
      return source === "cloudflare:workers" ? workersBinding : null;
    },
  }],
  build: {
    ssr: path.join(root, "server", "background-worker.mjs"),
    outDir: path.join(root, "dist", "worker"),
    emptyOutDir: true,
    target: "node22",
    sourcemap: true,
    minify: false,
    rollupOptions: {
      output: {
        entryFileNames: "background-worker.mjs",
      },
    },
  },
});
