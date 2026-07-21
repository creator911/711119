import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { openD1Database } from "../server/d1-sqlite.mjs";
import { applyMigrations, splitMigrationStatements } from "../server/migrate.mjs";

function temporaryDatabase() {
  const directory = mkdtempSync(path.join(tmpdir(), "nara-d1-"));
  const database = openD1Database(path.join(directory, "app.sqlite"));
  return {
    database,
    dispose() {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("D1-compatible statement methods expose rows and write metadata", async () => {
  const fixture = temporaryDatabase();
  try {
    await fixture.database.exec("CREATE TABLE things(id INTEGER PRIMARY KEY AUTOINCREMENT,name TEXT NOT NULL,score INTEGER NOT NULL)");
    const inserted = await fixture.database.prepare("INSERT INTO things(name,score) VALUES(?,?)").bind("첫 번째", 7).run();
    assert.equal(inserted.success, true);
    assert.equal(inserted.meta.changes, 1);
    assert.equal(inserted.meta.last_row_id, 1);

    assert.deepEqual(await fixture.database.prepare("SELECT id,name,score FROM things WHERE id=?").bind(1).first(), {
      id: 1,
      name: "첫 번째",
      score: 7,
    });
    assert.equal(await fixture.database.prepare("SELECT name FROM things WHERE id=?").bind(1).first("name"), "첫 번째");
    assert.equal(await fixture.database.prepare("SELECT id FROM things WHERE id=-1").first(), null);

    const all = await fixture.database.prepare("SELECT id,name FROM things ORDER BY id").all();
    assert.deepEqual(all.results, [{ id: 1, name: "첫 번째" }]);
    assert.deepEqual(await fixture.database.prepare("SELECT id,name FROM things").raw({ columnNames: true }), [
      ["id", "name"],
      [1, "첫 번째"],
    ]);

    const returned = await fixture.database.prepare("UPDATE things SET score=score+1 WHERE id=? RETURNING id,score").bind(1).all();
    assert.deepEqual(returned.results, [{ id: 1, score: 8 }]);
    assert.equal(returned.meta.changes, 1);
  } finally {
    fixture.dispose();
  }
});

test("batch is atomic and returns one D1 result per statement", async () => {
  const fixture = temporaryDatabase();
  try {
    await fixture.database.exec("CREATE TABLE guarded(id INTEGER PRIMARY KEY,value INTEGER NOT NULL CHECK(value >= 0))");
    const results = await fixture.database.batch([
      fixture.database.prepare("INSERT INTO guarded(id,value) VALUES(?,?)").bind(1, 10),
      fixture.database.prepare("SELECT value FROM guarded WHERE id=?").bind(1),
    ]);
    assert.equal(results[0].meta.changes, 1);
    assert.deepEqual(results[1].results, [{ value: 10 }]);

    await assert.rejects(
      fixture.database.batch([
        fixture.database.prepare("UPDATE guarded SET value=? WHERE id=1").bind(20),
        fixture.database.prepare("INSERT INTO guarded(id,value) VALUES(?,?)").bind(2, -1),
      ]),
      /CHECK constraint failed/,
    );
    assert.equal(await fixture.database.prepare("SELECT value FROM guarded WHERE id=1").first("value"), 10);
  } finally {
    fixture.dispose();
  }
});

test("all Drizzle migrations apply once and preserve trigger statements", () => {
  const fixture = temporaryDatabase();
  try {
    assert.deepEqual(splitMigrationStatements("SELECT 1;--> statement-breakpoint\r\nSELECT 2;"), ["SELECT 1;", "SELECT 2;"]);
    const first = applyMigrations(fixture.database);
    assert.equal(first.applied.length, 31);
    assert.deepEqual(applyMigrations(fixture.database), { applied: [] });

    assert.equal(fixture.database._allSync("SELECT COUNT(*) AS count FROM _node_migrations")[0].count, 31);
    assert.ok(fixture.database._allSync("PRAGMA table_info(users)").some(({ name }) => name === "level_locked"));
    assert.deepEqual(fixture.database._allSync("SELECT username FROM admin_owners ORDER BY username"), []);
    assert.equal(fixture.database._allSync("SELECT COUNT(*) AS count FROM featured_vendor_posts")[0].count, 4);
    assert.equal(fixture.database._allSync("SELECT COUNT(*) AS count FROM shop_products")[0].count, 10);
    assert.equal(fixture.database._allSync("SELECT value FROM site_settings WHERE key='main_domain'")[0].value, "https://nara001.co.kr");
    assert.equal(
      fixture.database._allSync("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='trigger' AND name='shop_purchase_apply_after_insert'")[0].count,
      1,
    );
  } finally {
    fixture.dispose();
  }
});

test("a failed migration rolls back every pending migration and its records", () => {
  const fixture = temporaryDatabase();
  const migrationsDir = mkdtempSync(path.join(tmpdir(), "nara-migrations-"));
  try {
    writeFileSync(path.join(migrationsDir, "0000_first.sql"), "CREATE TABLE first_table(id INTEGER PRIMARY KEY);");
    writeFileSync(
      path.join(migrationsDir, "0001_failure.sql"),
      "CREATE TABLE guarded(value INTEGER CHECK(value=0));--> statement-breakpoint\nINSERT INTO guarded(value) VALUES(1);",
    );

    assert.throws(() => applyMigrations(fixture.database, { migrationsDir }), /CHECK constraint failed/);
    assert.equal(fixture.database._allSync("SELECT COUNT(*) AS count FROM _node_migrations")[0].count, 0);
    assert.equal(
      fixture.database._allSync("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='first_table'")[0].count,
      0,
    );
  } finally {
    rmSync(migrationsDir, { recursive: true, force: true });
    fixture.dispose();
  }
});
