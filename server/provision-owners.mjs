import { pbkdf2Sync, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { openD1Database } from "./d1-sqlite.mjs";

const dataDirectory = path.resolve(process.env.NARA_DATA_DIR || ".nara-data");
const databasePath = path.resolve(process.env.NARA_DB_PATH || path.join(dataDirectory, "nara001.sqlite"));
const owners = [
  { username: "dow", password: process.env.OWNER_DOW_PASSWORD },
  { username: "pupu", password: process.env.OWNER_PUPU_PASSWORD },
];

for (const owner of owners) {
  if (!owner.password || owner.password.length < 8) {
    throw new Error(`A password of at least 8 characters is required for ${owner.username}`);
  }
}

mkdirSync(path.dirname(databasePath), { recursive: true });
const database = openD1Database(databasePath);
try {
  const now = new Date().toISOString();
  const statements = [database.prepare("DELETE FROM admin_owners WHERE username NOT IN ('dow','pupu')")];
  for (const owner of owners) {
    const salt = randomBytes(16);
    const hash = pbkdf2Sync(owner.password, salt, 100_000, 32, "sha256").toString("hex");
    statements.push(database.prepare(`
      INSERT INTO admin_owners(username,password_hash,password_salt,status,created_at)
      VALUES(?,?,?,'active',?)
      ON CONFLICT(username) DO UPDATE SET
        password_hash=excluded.password_hash,
        password_salt=excluded.password_salt,
        status='active'
    `).bind(owner.username, hash, salt.toString("hex"), now));
  }
  await database.batch(statements);
  console.log("Provisioned owner accounts: dow, pupu");
} finally {
  database.close?.();
}
