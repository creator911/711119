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

function rawChecksum(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function normalizedMigration(contents) {
  return contents.replace(/\r\n?/g, "\n");
}

function checksum(contents) {
  return rawChecksum(normalizedMigration(contents));
}

function compatibleChecksums(contents) {
  const normalized = normalizedMigration(contents);
  return new Set([
    rawChecksum(contents),
    rawChecksum(normalized),
    rawChecksum(normalized.replace(/\n/g, "\r\n")),
  ]);
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
      if (!compatibleChecksums(contents).has(applied.get(name))) throw new Error(`Applied migration has changed: ${name}`);
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
  if ((process.env.NARA_DATABASE_DRIVER || "sqlite").toLowerCase() === "postgres") {
    const { openPostgresD1Database } = await import("./d1-postgres.mjs");
    const database = openPostgresD1Database(process.env.DATABASE_URL, {
      max: 2,
      applicationName: "nara001-schema-check",
    });
    try {
      const required = ["users", "posts", "post_comments", "outbox_jobs", "member_activity_stats", "post_stats", "support_stats", "nara_schema_migrations"];
      const rows = await database.prepare(`
        SELECT table_name AS name FROM information_schema.tables
        WHERE table_schema=current_schema()
      `).all();
      const available = new Set(rows.results.map((row) => row.name));
      const missing = required.filter((table) => !available.has(table));
      if (missing.length) {
        throw new Error(`PostgreSQL schema is incomplete (${missing.join(", ")}). Run npm run db:copy:postgres during the migration window.`);
      }
      const expectedMigrations = migrationFiles(DEFAULT_MIGRATIONS_DIR);
      const applied = await database.prepare("SELECT name FROM nara_schema_migrations ORDER BY name").all();
      const appliedNames = new Set(applied.results.map((row) => row.name));
      const missingMigrations = expectedMigrations.filter((name) => !appliedNames.has(name));
      if (missingMigrations.length) {
        throw new Error(`PostgreSQL migrations are outdated (${missingMigrations.length} missing). Rehearse and apply an expand migration before activation.`);
      }
      console.log(`PostgreSQL schema check passed (${available.size} tables)`);
    } finally {
      await database.close();
    }
  } else {
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
}
