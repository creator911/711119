import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { openD1Database } from "./d1-sqlite.mjs";

const DEFAULT_MIGRATIONS_DIR = fileURLToPath(new URL("../drizzle/", import.meta.url));
const BREAKPOINT = /-->\s*statement-breakpoint\s*(?:\r?\n)?/g;

export function splitMigrationStatements(sql) {
  return sql.split(BREAKPOINT).map((statement) => statement.trim()).filter(Boolean);
}

function migrationFiles(migrationsDir) {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^\d+_.+\.sql$/i.test(entry.name))
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right, "en"));
}

function checksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

export function applyMigrations(database, { migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
  database._execSync(`
    CREATE TABLE IF NOT EXISTS _node_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Map(database._allSync("SELECT name,checksum FROM _node_migrations").map((row) => [row.name, row.checksum]));
  const pending = [];

  for (const name of migrationFiles(migrationsDir)) {
    const contents = readFileSync(path.join(migrationsDir, name), "utf8");
    const digest = checksum(contents);
    if (applied.has(name)) {
      if (applied.get(name) !== digest) throw new Error(`Applied migration has changed: ${name}`);
      continue;
    }
    pending.push({ name, digest, statements: splitMigrationStatements(contents) });
  }

  if (!pending.length) return { applied: [] };

  const appliedAt = new Date().toISOString();
  database._transaction(() => {
    for (const migration of pending) {
      for (const statement of migration.statements) database._execSync(statement);
      database._runSync(
        "INSERT INTO _node_migrations(name,checksum,applied_at) VALUES(?,?,?)",
        [migration.name, migration.digest, appliedAt],
      );
    }
  });

  return { applied: pending.map(({ name }) => name) };
}

export { DEFAULT_MIGRATIONS_DIR };

function productionDatabasePath() {
  const dataDirectory = path.resolve(process.env.NARA_DATA_DIR || ".nara-data");
  return path.resolve(process.env.NARA_DB_PATH || path.join(dataDirectory, "nara001.sqlite"));
}

function isMainModule() {
  return Boolean(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
}

if (isMainModule()) {
  const databasePath = productionDatabasePath();
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = openD1Database(databasePath);
  try {
    const migrated = applyMigrations(database);
    console.log(`Applied ${migrated.applied.length} migration(s) to ${databasePath}`);
  } finally {
    database.close();
  }
}
