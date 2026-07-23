export const IP_FAILURE_LIMIT = 10;
export const IP_BLOCK_MS = 30 * 60 * 1000;
export const PASSWORD_FAILURE_LIMIT = 5;
export const ACCOUNT_BLOCK_MS = 10 * 60 * 1000;
export const LOGIN_FAILURE_IDLE_RESET_MS = 10 * 60 * 1000;
export const LOGIN_FAILURE_RETENTION_MS = 24 * 60 * 60 * 1000;

export type LoginFailureTable =
  | "admin_ip_login_failures"
  | "admin_account_login_failures"
  | "member_ip_login_failures"
  | "member_account_login_failures";
export type LoginFailureColumn = "ip" | "username";
export type LoginFailureRow = { failure_count: number; blocked_until: string | null; updated_at: string };

type LoginFailureDatabase = {
  prepare: (query: string) => {
    bind: (...values: unknown[]) => {
      first: <T>() => Promise<T | null>;
      run: () => Promise<unknown>;
    };
  };
};

export async function activeLoginFailure(
  database: LoginFailureDatabase,
  table: LoginFailureTable,
  keyColumn: LoginFailureColumn,
  key: string,
  nowMs = Date.now(),
  idleResetMs?: number,
) {
  const row = await database.prepare(`SELECT failure_count,blocked_until,updated_at FROM ${table} WHERE ${keyColumn}=?`)
    .bind(key).first<LoginFailureRow>();
  if (!row) return null;
  if (row.blocked_until && Date.parse(row.blocked_until) > nowMs) return row;
  const idleExpired = idleResetMs !== undefined && Date.parse(row.updated_at) <= nowMs - idleResetMs;
  if (row.blocked_until || idleExpired) {
    await database.prepare(`DELETE FROM ${table} WHERE ${keyColumn}=?`).bind(key).run();
    return null;
  }
  return row;
}

export async function recordLoginFailure(
  database: LoginFailureDatabase,
  table: LoginFailureTable,
  keyColumn: LoginFailureColumn,
  key: string,
  limit: number,
  blockMs: number,
  nowMs = Date.now(),
) {
  const now = new Date(nowMs).toISOString();
  await database.prepare(
    `INSERT INTO ${table} (${keyColumn},failure_count,blocked_until,updated_at) VALUES (?,1,NULL,?)
     ON CONFLICT(${keyColumn}) DO UPDATE SET failure_count=failure_count+1,blocked_until=NULL,updated_at=excluded.updated_at`,
  ).bind(key, now).run();
  const row = await database.prepare(`SELECT failure_count,blocked_until FROM ${table} WHERE ${keyColumn}=?`)
    .bind(key).first<LoginFailureRow>();
  if ((row?.failure_count ?? 0) < limit) return null;
  const blockedUntil = new Date(nowMs + blockMs).toISOString();
  await database.prepare(`UPDATE ${table} SET failure_count=?,blocked_until=?,updated_at=? WHERE ${keyColumn}=?`)
    .bind(limit, blockedUntil, now, key).run();
  return blockedUntil;
}

export async function recordPasswordFailure(
  database: LoginFailureDatabase,
  ip: string,
  username: string,
  nowMs = Date.now(),
) {
  const ipBlockedUntil = await recordLoginFailure(
    database, "admin_ip_login_failures", "ip", ip, IP_FAILURE_LIMIT, IP_BLOCK_MS, nowMs,
  );
  const accountBlockedUntil = await recordLoginFailure(
    database, "admin_account_login_failures", "username", username, PASSWORD_FAILURE_LIMIT, ACCOUNT_BLOCK_MS, nowMs,
  );
  return { ipBlockedUntil, accountBlockedUntil };
}

export async function pruneLoginFailures(
  database: LoginFailureDatabase,
  scope: "admin" | "member",
  nowMs = Date.now(),
  perTableLimit = 500,
) {
  const boundedLimit = Math.max(1, Math.min(2_000, Math.trunc(perTableLimit)));
  const cutoff = new Date(nowMs - LOGIN_FAILURE_RETENTION_MS).toISOString();
  const tables: LoginFailureTable[] = scope === "admin"
    ? ["admin_ip_login_failures", "admin_account_login_failures"]
    : ["member_ip_login_failures", "member_account_login_failures"];
  for (const table of tables) {
    const keyColumn: LoginFailureColumn = table.includes("_ip_") ? "ip" : "username";
    await database.prepare(`
      DELETE FROM ${table}
      WHERE rowid IN (
        SELECT rowid FROM ${table}
        WHERE updated_at<=?
        ORDER BY updated_at,${keyColumn}
        LIMIT ?
      )
    `).bind(cutoff, boundedLimit).run();
  }
}

export function shouldRunLoginFailureMaintenance(key: string, nowMs = Date.now(), modulo = 64) {
  const boundedModulo = Math.max(1, Math.trunc(modulo));
  let hash = Math.floor(nowMs / (5 * 60 * 1000));
  for (let index = 0; index < key.length; index += 1) hash = Math.imul(hash ^ key.charCodeAt(index), 16_777_619);
  return (hash >>> 0) % boundedModulo === 0;
}
