import path from "node:path";
import { mkdirSync } from "node:fs";
import { openD1Database } from "./d1-sqlite.mjs";
import { openPostgresD1Database } from "./d1-postgres.mjs";
import { createFilesystemR2Bucket } from "./r2-filesystem.mjs";
import { createS3R2BucketFromEnvironment } from "./r2-s3.mjs";
import { createValkeyBinding } from "./valkey.mjs";

const production = process.env.NODE_ENV === "production";
const applicationSurface = process.env.NARA_APP_SURFACE || "all";
if (production) {
  const requiredSecrets = applicationSurface === "public"
    ? ["CAPTCHA_SECRET"]
    : applicationSurface === "admin"
      ? ["ADMIN_SESSION_SECRET"]
      : applicationSurface === "worker"
        ? []
        : ["ADMIN_SESSION_SECRET", "CAPTCHA_SECRET"];
  for (const name of requiredSecrets) {
    if (!process.env[name] || process.env[name].length < 32) {
      throw new Error(`${name} must be configured with at least 32 characters`);
    }
  }
}

const dataDirectory = path.resolve(process.env.NARA_DATA_DIR || ".nara-data");
const databasePath = path.resolve(process.env.NARA_DB_PATH || path.join(dataDirectory, "nara001.sqlite"));
const mediaDirectory = path.resolve(process.env.NARA_MEDIA_DIR || path.join(dataDirectory, "media"));
const databaseDriver = (process.env.NARA_DATABASE_DRIVER || "sqlite").toLowerCase();
const remoteMedia = createS3R2BucketFromEnvironment();
if (databaseDriver === "sqlite") mkdirSync(path.dirname(databasePath), { recursive: true });
if (!remoteMedia) mkdirSync(mediaDirectory, { recursive: true });

const bindings = {
  DB: databaseDriver === "postgres"
    ? openPostgresD1Database(process.env.DATABASE_URL, {
      max: Number(process.env.POSTGRES_POOL_MAX || 20),
      applicationName: process.env.NARA_APP_SURFACE || "nara001",
    })
    : openD1Database(databasePath),
  MEDIA: remoteMedia ?? createFilesystemR2Bucket(mediaDirectory),
  CACHE: createValkeyBinding(process.env.VALKEY_URL),
  APP_SURFACE: applicationSurface,
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
