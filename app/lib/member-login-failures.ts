import {
  activeLoginFailure,
  LOGIN_FAILURE_IDLE_RESET_MS,
  pruneLoginFailures,
  recordLoginFailure,
  shouldRunLoginFailureMaintenance,
} from "./admin-login-failures.ts";

export const MEMBER_IP_FAILURE_LIMIT = 20;
export const MEMBER_IP_BLOCK_MS = 30 * 60 * 1000;
export const MEMBER_ACCOUNT_FAILURE_LIMIT = 5;
export const MEMBER_ACCOUNT_BLOCK_MS = 10 * 60 * 1000;

type MemberLoginFailureDatabase = Parameters<typeof activeLoginFailure>[0];

export function activeMemberIpFailure(database: MemberLoginFailureDatabase, ip: string, nowMs = Date.now()) {
  return activeLoginFailure(
    database,
    "member_ip_login_failures",
    "ip",
    ip,
    nowMs,
    LOGIN_FAILURE_IDLE_RESET_MS,
  );
}

export function activeMemberAccountFailure(database: MemberLoginFailureDatabase, username: string, nowMs = Date.now()) {
  return activeLoginFailure(
    database,
    "member_account_login_failures",
    "username",
    username,
    nowMs,
    LOGIN_FAILURE_IDLE_RESET_MS,
  );
}

export async function recordMemberPasswordFailure(
  database: MemberLoginFailureDatabase,
  ip: string,
  username: string,
  nowMs = Date.now(),
) {
  const ipBlockedUntil = await recordLoginFailure(
    database,
    "member_ip_login_failures",
    "ip",
    ip,
    MEMBER_IP_FAILURE_LIMIT,
    MEMBER_IP_BLOCK_MS,
    nowMs,
  );
  const accountBlockedUntil = await recordLoginFailure(
    database,
    "member_account_login_failures",
    "username",
    username,
    MEMBER_ACCOUNT_FAILURE_LIMIT,
    MEMBER_ACCOUNT_BLOCK_MS,
    nowMs,
  );
  return { ipBlockedUntil, accountBlockedUntil };
}

export async function maybePruneMemberLoginFailures(
  database: MemberLoginFailureDatabase,
  maintenanceKey: string,
  nowMs = Date.now(),
) {
  if (!shouldRunMemberLoginMaintenance(maintenanceKey, nowMs)) return;
  await pruneLoginFailures(database, "member", nowMs);
}

export function shouldRunMemberLoginMaintenance(maintenanceKey: string, nowMs = Date.now()) {
  return shouldRunLoginFailureMaintenance(maintenanceKey, nowMs);
}
