import { DatabaseSync } from "node:sqlite";

const now = () => performance.now();

function bindingValue(value) {
  if (value === undefined) throw new TypeError("D1 bindings cannot contain undefined");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value) && !(value instanceof Uint8Array)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function plainRow(row) {
  if (row == null || typeof row !== "object" || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row));
}

function integer(value) {
  if (typeof value === "bigint") return Number(value);
  return Number(value ?? 0);
}

function meta(duration, changes = 0, lastRowId = 0) {
  return {
    changed_db: changes > 0,
    changes: integer(changes),
    duration,
    last_row_id: integer(lastRowId),
    rows_read: 0,
    rows_written: integer(changes),
    size_after: 0,
  };
}

function result(results, duration, changes = 0, lastRowId = 0) {
  return {
    success: true,
    results,
    meta: meta(duration, changes, lastRowId),
  };
}

function writesDatabase(query) {
  const withoutComments = query
    .replace(/^\s*(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/\s*)*/u, "")
    .trimStart();
  return /^(?:INSERT|UPDATE|DELETE|REPLACE|CREATE|ALTER|DROP|VACUUM|REINDEX|ANALYZE|ATTACH|DETACH)\b/i.test(withoutComments);
}

function pragmaToken(value, name) {
  const token = String(value).toUpperCase();
  if (!/^[A-Z_]+$/.test(token)) throw new TypeError(`Invalid ${name} pragma value`);
  return token;
}

export class SQLiteD1PreparedStatement {
  #database;
  #query;
  #bindings;

  constructor(database, query, bindings = []) {
    this.#database = database;
    this.#query = query;
    this.#bindings = bindings;
  }

  bind(...values) {
    return new SQLiteD1PreparedStatement(this.#database, this.#query, values.map(bindingValue));
  }

  async first(columnName) {
    const row = this.#database._get(this.#query, this.#bindings);
    if (row === undefined) return null;
    const normalized = plainRow(row);
    if (columnName === undefined) return normalized;
    if (!Object.hasOwn(normalized, columnName)) {
      throw new Error(`Column not found: ${columnName}`);
    }
    return normalized[columnName];
  }

  async all() {
    return this.#database._all(this.#query, this.#bindings);
  }

  async run() {
    return this.#database._run(this.#query, this.#bindings);
  }

  async raw(options = {}) {
    return this.#database._raw(this.#query, this.#bindings, options);
  }

  _executeForBatch() {
    return this.#database._executeForBatch(this.#query, this.#bindings);
  }

  _belongsTo(database) {
    return this.#database === database;
  }
}

export class SQLiteD1Database {
  #sqlite;
  #closed = false;

  constructor(filename, {
    busyTimeout = 5_000,
    foreignKeys = true,
    journalMode = "WAL",
    synchronous = "NORMAL",
  } = {}) {
    this.#sqlite = new DatabaseSync(filename);
    this.#sqlite.exec(`PRAGMA busy_timeout=${Math.max(0, Math.trunc(busyTimeout))}`);
    this.#sqlite.exec(`PRAGMA foreign_keys=${foreignKeys ? "ON" : "OFF"}`);
    if (journalMode) this.#sqlite.exec(`PRAGMA journal_mode=${pragmaToken(journalMode, "journalMode")}`);
    if (synchronous) this.#sqlite.exec(`PRAGMA synchronous=${pragmaToken(synchronous, "synchronous")}`);
  }

  prepare(query) {
    this.#assertOpen();
    if (typeof query !== "string" || !query.trim()) throw new TypeError("SQL query must be a non-empty string");
    return new SQLiteD1PreparedStatement(this, query);
  }

  async batch(statements) {
    this.#assertOpen();
    if (!Array.isArray(statements)) throw new TypeError("batch() expects an array of prepared statements");
    for (const statement of statements) {
      if (!(statement instanceof SQLiteD1PreparedStatement) || !statement._belongsTo(this)) {
        throw new TypeError("Every batch entry must be prepared by this database");
      }
    }

    this.#sqlite.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map((statement) => statement._executeForBatch());
      this.#sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      try {
        this.#sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the statement error that caused the rollback.
      }
      throw error;
    }
  }

  async exec(query) {
    this.#assertOpen();
    const startedAt = now();
    this.#sqlite.exec(query);
    return { count: 1, duration: now() - startedAt };
  }

  close() {
    if (this.#closed) return;
    this.#sqlite.close();
    this.#closed = true;
  }

  _get(query, bindings) {
    this.#assertOpen();
    return this.#sqlite.prepare(query).get(...bindings);
  }

  _all(query, bindings) {
    this.#assertOpen();
    const startedAt = now();
    const rows = this.#sqlite.prepare(query).all(...bindings).map(plainRow);
    const writeMeta = writesDatabase(query) ? this.#writeMeta() : { changes: 0, lastRowId: 0 };
    return result(rows, now() - startedAt, writeMeta.changes, writeMeta.lastRowId);
  }

  _run(query, bindings) {
    this.#assertOpen();
    const startedAt = now();
    const runResult = this.#sqlite.prepare(query).run(...bindings);
    return result([], now() - startedAt, runResult.changes, runResult.lastInsertRowid);
  }

  _raw(query, bindings, options) {
    this.#assertOpen();
    const statement = this.#sqlite.prepare(query);
    if (typeof statement.setReturnArrays === "function" && typeof statement.columns === "function") {
      const columnNames = statement.columns().map(({ name }) => name);
      statement.setReturnArrays(true);
      const rows = statement.all(...bindings).map((row) => [...row]);
      const includeColumns = options === true || options?.columnNames === true;
      return includeColumns ? [columnNames, ...rows] : rows;
    }

    const objectRows = statement.all(...bindings).map(plainRow);
    const columnNames = objectRows.length ? Object.keys(objectRows[0]) : [];
    const rows = objectRows.map((row) => columnNames.map((name) => row[name]));
    const includeColumns = options === true || options?.columnNames === true;
    return includeColumns ? [columnNames, ...rows] : rows;
  }

  _executeForBatch(query, bindings) {
    this.#assertOpen();
    const statement = this.#sqlite.prepare(query);
    const startedAt = now();
    const rows = statement.all(...bindings).map(plainRow);
    const writeMeta = writesDatabase(query) ? this.#writeMeta() : { changes: 0, lastRowId: 0 };
    return result(rows, now() - startedAt, writeMeta.changes, writeMeta.lastRowId);
  }

  _transaction(action, mode = "IMMEDIATE") {
    this.#assertOpen();
    this.#sqlite.exec(`BEGIN ${mode}`);
    try {
      const value = action();
      this.#sqlite.exec("COMMIT");
      return value;
    } catch (error) {
      try {
        this.#sqlite.exec("ROLLBACK");
      } catch {
        // Preserve the original migration or application error.
      }
      throw error;
    }
  }

  _execSync(query) {
    this.#assertOpen();
    this.#sqlite.exec(query);
  }

  _allSync(query, bindings = []) {
    this.#assertOpen();
    return this.#sqlite.prepare(query).all(...bindings).map(plainRow);
  }

  _runSync(query, bindings = []) {
    this.#assertOpen();
    return this.#sqlite.prepare(query).run(...bindings);
  }

  #writeMeta() {
    const row = this.#sqlite.prepare("SELECT changes() AS changes,last_insert_rowid() AS lastRowId").get();
    return { changes: row.changes, lastRowId: row.lastRowId };
  }

  #assertOpen() {
    if (this.#closed) throw new Error("SQLite database is closed");
  }
}

export function openD1Database(filename, options) {
  return new SQLiteD1Database(filename, options);
}
