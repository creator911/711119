import path from "node:path";
import { mkdirSync } from "node:fs";
import { openD1Database } from "./d1-sqlite.mjs";
import { createFilesystemR2Bucket } from "./r2-filesystem.mjs";

const production = process.env.NODE_ENV === "production";
if (production) {
  for (const name of ["ADMIN_SESSION_SECRET", "CAPTCHA_SECRET"]) {
    if (!process.env[name] || process.env[name].length < 32) {
      throw new Error(`${name} must be configured with at least 32 characters`);
    }
  }
}

const dataDirectory = path.resolve(process.env.NARA_DATA_DIR || ".nara-data");
const databasePath = path.resolve(process.env.NARA_DB_PATH || path.join(dataDirectory, "nara001.sqlite"));
const mediaDirectory = path.resolve(process.env.NARA_MEDIA_DIR || path.join(dataDirectory, "media"));
mkdirSync(path.dirname(databasePath), { recursive: true });
mkdirSync(mediaDirectory, { recursive: true });

const bindings = {
  DB: openD1Database(databasePath),
  MEDIA: createFilesystemR2Bucket(mediaDirectory),
};

export const env = new Proxy(bindings, {
  get(target, property) {
    if (Reflect.has(target, property)) return Reflect.get(target, property);
    return typeof property === "string" ? process.env[property] : undefined;
  },
  has(target, property) {
    return Reflect.has(target, property) || (typeof property === "string" && property in process.env);
  },
});
