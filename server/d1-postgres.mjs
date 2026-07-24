import pg from "pg";

const { Pool, types } = pg;
types.setTypeParser(20, (value) => Number(value));

const now = () => performance.now();

function bindingValue(value) {
  if (value === undefined) throw new TypeError("D1 bindings cannot contain undefined");
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  return value;
}

function d1Meta(duration, changes = 0, lastRowId = 0) {
  return {
    changed_db: changes > 0,
    changes: Number(changes || 0),
    duration,
    last_row_id: Number(lastRowId || 0),
    rows_read: 0,
    rows_written: Number(changes || 0),
    size_after: 0,
  };
}

function d1Result(rows, duration, changes = 0, lastRowId = 0) {
  return { success: true, results: rows, meta: d1Meta(duration, changes, lastRowId) };
}

function placeholderSql(sql) {
  let index = 0;
  let quoted = "";
  let result = "";
  for (let offset = 0; offset < sql.length; offset += 1) {
    const character = sql[offset];
    if (quoted) {
      result += character;
      if (character === quoted) {
        if (sql[offset + 1] === quoted) {
          result += sql[offset + 1];
          offset += 1;
        } else {
          quoted = "";
        }
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quoted = character;
      result += character;
      continue;
    }
    if (character === "?") {
      index += 1;
      result += `$${index}`;
      continue;
    }
    result += character;
  }
  return result;
}

function appendConflictDoNothing(sql) {
  if (!/^\s*INSERT\s+INTO\b/i.test(sql) || /\bON\s+CONFLICT\b/i.test(sql)) return sql;
  const semicolon = /;\s*$/.test(sql) ? ";" : "";
  return `${sql.replace(/;\s*$/, "").trimEnd()} ON CONFLICT DO NOTHING${semicolon}`;
}

function preserveCamelCaseAliases(sql) {
  return sql.replace(/\bAS\s+([A-Za-z_][A-Za-z0-9_]*)\b/g, (match, alias) => (
    /[a-z]/.test(alias) && /[A-Z]/.test(alias) ? `AS "${alias}"` : match
  ));
}

export function translateSqliteSql(input) {
  let sql = String(input)
    .replace(/`([^`]+)`/g, '"$1"')
    .replace(/\s+INDEXED\s+BY\s+(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)/gi, "")
    .replace(/\browid\b/gi, "ctid")
    .replace(/\bINSERT\s+OR\s+IGNORE\s+INTO\b/i, "INSERT INTO");

  const wasInsertOrIgnore = /\bINSERT\s+OR\s+IGNORE\s+INTO\b/i.test(String(input));
  sql = preserveCamelCaseAliases(sql);
  sql = placeholderSql(sql);
  sql = sql
    .replace(
      /((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))*)\s*(LIKE|=)\s*(\$\d+)\s+COLLATE\s+NOCASE\b/gi,
      (_, expression, operator, parameter) => `LOWER(${expression}) ${operator.toUpperCase()} LOWER(${parameter})`,
    )
    .replace(
      /((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))*)\s+COLLATE\s+NOCASE\s*(LIKE|=)\s*(\$\d+)/gi,
      (_, expression, operator, parameter) => `LOWER(${expression}) ${operator.toUpperCase()} LOWER(${parameter})`,
    )
    .replace(
      /((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_]*))*)\s+COLLATE\s+NOCASE\b/gi,
      (_, expression) => `LOWER(${expression})`,
    )
    .replace(
      /\binstr\((lower\([^()]+\)|[^,()]+),\s*(lower\(\$\d+\)|\$\d+)\)/gi,
      "strpos($1,$2)",
    );
  if (wasInsertOrIgnore) sql = appendConflictDoNothing(sql);
  return sql;
}

function insertTable(sql) {
  const match = /^\s*INSERT\s+(?:OR\s+IGNORE\s+)?INTO\s+(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_]*))/i.exec(sql);
  return match?.[1] ?? match?.[2] ?? "";
}

function hasReturning(sql) {
  return /\bRETURNING\b/i.test(sql);
}

class PostgresD1PreparedStatement {
  constructor(database, query, bindings = []) {
    this.database = database;
    this.query = query;
    this.bindings = bindings;
  }

  bind(...values) {
    return new PostgresD1PreparedStatement(this.database, this.query, values.map(bindingValue));
  }

  async first(columnName) {
    const result = await this.database._execute(this.query, this.bindings, { first: true });
    const row = result.results[0];
    if (row === undefined) return null;
    if (columnName === undefined) return row;
    if (!Object.hasOwn(row, columnName)) throw new Error(`Column not found: ${columnName}`);
    return row[columnName];
  }

  all() {
    return this.database._execute(this.query, this.bindings);
  }

  run() {
    return this.database._execute(this.query, this.bindings, { generatedId: true });
  }

  async raw(options = {}) {
    const result = await this.database._execute(this.query, this.bindings);
    const columnNames = result.results.length ? Object.keys(result.results[0]) : [];
    const rows = result.results.map((row) => columnNames.map((name) => row[name]));
    return options === true || options?.columnNames === true ? [columnNames, ...rows] : rows;
  }

  _belongsTo(database) {
    return this.database === database;
  }
}

export class PostgresD1Database {
  constructor(connectionOrOptions, options = {}) {
    const suppliedPool = options.pool ?? connectionOrOptions?.pool;
    this.pool = suppliedPool ?? new Pool({
      connectionString: typeof connectionOrOptions === "string"
        ? connectionOrOptions
        : connectionOrOptions?.connectionString,
      max: Number(options.max ?? connectionOrOptions?.max ?? process.env.POSTGRES_POOL_MAX ?? 20),
      idleTimeoutMillis: Number(options.idleTimeoutMillis ?? 30_000),
      connectionTimeoutMillis: Number(options.connectionTimeoutMillis ?? 5_000),
      statement_timeout: Number(options.statementTimeoutMs ?? 5_000),
      application_name: options.applicationName ?? process.env.NARA_APP_SURFACE ?? "nara001",
      ssl: options.ssl ?? (process.env.POSTGRES_SSL === "disable" ? false : { rejectUnauthorized: false }),
    });
    this.ownsPool = !suppliedPool;
    this.idColumns = new Map();
  }

  prepare(query) {
    if (typeof query !== "string" || !query.trim()) throw new TypeError("SQL query must be a non-empty string");
    return new PostgresD1PreparedStatement(this, query);
  }

  async batch(statements) {
    if (!Array.isArray(statements)) throw new TypeError("batch() expects an array of prepared statements");
    for (const statement of statements) {
      if (!(statement instanceof PostgresD1PreparedStatement) || !statement._belongsTo(this)) {
        throw new TypeError("Every batch entry must be prepared by this database");
      }
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const statement of statements) {
        results.push(await this._execute(statement.query, statement.bindings, {
          client,
          generatedId: true,
        }));
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async exec(query) {
    const startedAt = now();
    await this.pool.query(translateSqliteSql(query));
    return { count: 1, duration: now() - startedAt };
  }

  async close() {
    if (this.ownsPool) await this.pool.end();
  }

  async _hasIdColumn(table, client) {
    if (!table) return false;
    if (this.idColumns.has(table)) return this.idColumns.get(table);
    const result = await client.query(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
         WHERE table_schema=current_schema() AND table_name=$1 AND column_name='id'
       ) AS present`,
      [table],
    );
    const present = Boolean(result.rows[0]?.present);
    this.idColumns.set(table, present);
    return present;
  }

  async _execute(query, bindings, options = {}) {
    const client = options.client ?? this.pool;
    let sql = translateSqliteSql(query);
    const table = insertTable(sql);
    if (options.generatedId && table && !hasReturning(sql) && await this._hasIdColumn(table, client)) {
      sql = `${sql.replace(/;\s*$/, "").trimEnd()} RETURNING id`;
    }
    const startedAt = now();
    const result = await client.query(sql, bindings);
    const duration = now() - startedAt;
    const lastRowId = result.rows?.[0]?.id ?? 0;
    return d1Result(result.rows ?? [], duration, result.rowCount ?? 0, lastRowId);
  }
}

export function openPostgresD1Database(connectionString, options) {
  if (!connectionString && !options?.pool) throw new Error("DATABASE_URL is required for the PostgreSQL driver");
  return new PostgresD1Database(connectionString, options);
}
