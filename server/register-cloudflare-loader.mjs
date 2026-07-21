import { register } from "node:module";

register(new URL("./cloudflare-loader.mjs", import.meta.url));
