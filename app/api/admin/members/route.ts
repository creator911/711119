import { env } from "cloudflare:workers";
import {
  DEFAULT_ADMIN_PAGE_SIZE,
  isAdminPageSize,
  MAX_ADMIN_MEMBER_BATCH_UPDATES,
} from "../../../lib/admin-pagination";
import { adminSession } from "../../../lib/admin-auth";
import { normalizeAdminMemberFlags } from "../../../lib/admin-member-flags";
import { ADMIN_MEMBER_PREFIX_WHERE_SQL, adminMemberPrefixSearch, MIN_ADMIN_MEMBER_SEARCH_CHARACTERS } from "../../../lib/admin-member-search";
import { isMemberLevel } from "../../../lib/member-level";
import { invalidateMemberSessionsByUserIds } from "../../../lib/member-auth";
import { isUniqueConstraintError } from "../../../lib/database-errors";

type AdminMemberRow = {
  id: number;
  username: string;
  nickname: string;
  signupIp: string;
  firstLoginIp: string | null;
  points: number;
  level: number;
  levelLocked: number | boolean;
  isDirector: number | boolean;
  isPartner: number | boolean;
  status: string;
  createdAt: string;
};

type AdminMemberUpdate = {
  id?: number;
  nickname?: string;
  points?: number;
  level?: number;
  levelLocked?: boolean;
  status?: string;
  isDirector?: boolean;
  isPartner?: boolean;
};

type CurrentAdminMember = {
  id: number;
  level: number;
  levelLocked: number | boolean;
  isDirector: number | boolean;
  isPartner: number | boolean;
};

const PRIVATE_NO_STORE_HEADERS = { "Cache-Control": "private, no-store, max-age=0" };
const MEMBER_SORT_SQL = {
  created_desc: "created_at DESC, id DESC",
  created_asc: "created_at ASC, id ASC",
  points_desc: "points DESC, id DESC",
  points_asc: "points ASC, id ASC",
  director_first: "is_director DESC, created_at DESC, id DESC",
  partner_first: "is_partner DESC, created_at DESC, id DESC",
  username_asc: "username COLLATE NOCASE ASC, id ASC",
  username_desc: "username COLLATE NOCASE DESC, id DESC",
  nickname_asc: "nickname COLLATE NOCASE ASC, id ASC",
  nickname_desc: "nickname COLLATE NOCASE DESC, id DESC",
  level_desc: "level DESC, id DESC",
  level_asc: "level ASC, id ASC",
} as const;

type MemberSort = keyof typeof MEMBER_SORT_SQL;

const positiveInteger = (value: string | null, fallback: number) => {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

export async function GET(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401, headers: PRIVATE_NO_STORE_HEADERS });

  const url = new URL(request.url);
  const sort = (url.searchParams.get("sort") || "created_desc") as MemberSort;
  const requestedPage = positiveInteger(url.searchParams.get("page"), 1);
  const requestedPageSize = positiveInteger(url.searchParams.get("pageSize"), DEFAULT_ADMIN_PAGE_SIZE);
  if (!Object.hasOwn(MEMBER_SORT_SQL, sort) || requestedPage === null || requestedPageSize === null || !isAdminPageSize(requestedPageSize)) {
    return Response.json({ error: "회원 목록 조회 조건을 확인해 주세요." }, { status: 400, headers: PRIVATE_NO_STORE_HEADERS });
  }

  const search = adminMemberPrefixSearch(url.searchParams.get("q") ?? "");
  if (!search) {
    return Response.json({ error: "검색어가 너무 깁니다." }, { status: 400, headers: PRIVATE_NO_STORE_HEADERS });
  }
  if (search.query && search.query.length < MIN_ADMIN_MEMBER_SEARCH_CHARACTERS) {
    return Response.json({ error: `검색어를 ${MIN_ADMIN_MEMBER_SEARCH_CHARACTERS}자 이상 입력해 주세요.` }, { status: 400, headers: PRIVATE_NO_STORE_HEADERS });
  }
  const { query, pattern } = search;
  const whereSql = query ? `WHERE ${ADMIN_MEMBER_PREFIX_WHERE_SQL}` : "";
  const countStatement = env.DB.prepare(`SELECT COUNT(*) AS count FROM users ${whereSql}`);
  const countRow = query
    ? await countStatement.bind(pattern, pattern).first<{ count: number }>()
    : await countStatement.first<{ count: number }>();
  const total = Number(countRow?.count ?? 0);
  const totalPages = Math.max(1, Math.ceil(total / requestedPageSize));
  const page = Math.min(requestedPage, totalPages);
  const offset = (page - 1) * requestedPageSize;
  const listStatement = env.DB.prepare(`
    SELECT id,username,nickname,signup_ip AS signupIp,first_login_ip AS firstLoginIp,
           points,level,level_locked AS levelLocked,is_director AS isDirector,
           is_partner AS isPartner,status,created_at AS createdAt
    FROM users
    ${whereSql}
    ORDER BY ${MEMBER_SORT_SQL[sort]}
    LIMIT ? OFFSET ?
  `);
  const result = query
    ? await listStatement.bind(pattern, pattern, requestedPageSize, offset).all<AdminMemberRow>()
    : await listStatement.bind(requestedPageSize, offset).all<AdminMemberRow>();

  return Response.json({
    members: result.results.map(normalizeAdminMemberFlags),
    total,
    page,
    pageSize: requestedPageSize,
    totalPages,
    sort,
    query,
  }, { headers: PRIVATE_NO_STORE_HEADERS });
}

const ADMIN_MEMBER_UPDATE_FIELDS = ["nickname", "points", "level", "levelLocked", "status", "isDirector", "isPartner"] as const;
const ADMIN_MEMBER_UPDATE_KEYS = new Set<string>(["id", ...ADMIN_MEMBER_UPDATE_FIELDS]);
const hasOwn = (value: object, key: string) => Object.hasOwn(value, key);

function normalizedMemberUpdate(value: Record<string, unknown>): AdminMemberUpdate | null {
  if (Object.keys(value).some((key) => !ADMIN_MEMBER_UPDATE_KEYS.has(key))) return null;
  if (!Number.isInteger(value.id) || Number(value.id) < 1) return null;

  const update: AdminMemberUpdate = { id: value.id as number };
  let changedFieldCount = 0;
  if (hasOwn(value, "nickname")) {
    if (typeof value.nickname !== "string") return null;
    const nickname = value.nickname.trim();
    if (nickname.length < 2 || nickname.length > 12) return null;
    update.nickname = nickname;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "points")) {
    if (!Number.isInteger(value.points) || Number(value.points) < 0 || Number(value.points) > 1_000_000_000) return null;
    update.points = value.points as number;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "level")) {
    if (!isMemberLevel(value.level)) return null;
    update.level = value.level;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "levelLocked")) {
    if (typeof value.levelLocked !== "boolean") return null;
    update.levelLocked = value.levelLocked;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "status")) {
    if (value.status !== "active" && value.status !== "suspended") return null;
    update.status = value.status;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "isDirector")) {
    if (typeof value.isDirector !== "boolean") return null;
    update.isDirector = value.isDirector;
    changedFieldCount += 1;
  }
  if (hasOwn(value, "isPartner")) {
    if (typeof value.isPartner !== "boolean") return null;
    update.isPartner = value.isPartner;
    changedFieldCount += 1;
  }
  return changedFieldCount ? update : null;
}

export async function PATCH(request: Request) {
  const operator = await adminSession(request, env);
  if (!operator) return Response.json({ error: "관리자 로그인이 필요합니다." }, { status: 401 });

  let rawPayload: unknown;
  try {
    rawPayload = await request.json();
  } catch {
    return Response.json({ error: "회원 정보 형식을 확인해 주세요." }, { status: 400 });
  }
  if (!rawPayload || typeof rawPayload !== "object" || Array.isArray(rawPayload)) {
    return Response.json({ error: "회원 정보 형식을 확인해 주세요." }, { status: 400 });
  }

  const payload = rawPayload as Record<string, unknown>;
  const rawUpdates = hasOwn(payload, "members") ? payload.members : [payload];
  if (!Array.isArray(rawUpdates) || !rawUpdates.length || rawUpdates.length > MAX_ADMIN_MEMBER_BATCH_UPDATES) {
    return Response.json({ error: "한 번에 저장할 회원 수를 확인해 주세요." }, { status: 400 });
  }
  const updates = rawUpdates.map((update) => update && typeof update === "object" && !Array.isArray(update)
    ? normalizedMemberUpdate(update as Record<string, unknown>)
    : null);
  if (updates.some((update) => update === null)) {
    return Response.json({ error: "회원 정보 형식을 확인해 주세요." }, { status: 400 });
  }
  const validUpdates = updates as AdminMemberUpdate[];
  const ids = validUpdates.map((update) => update.id as number);
  if (new Set(ids).size !== ids.length) {
    return Response.json({ error: "동일한 회원이 중복 포함되어 있습니다." }, { status: 400 });
  }

  try {
    const placeholders = ids.map(() => "?").join(",");
    const currentResult = await env.DB.prepare(`
      SELECT id,level,level_locked AS levelLocked,is_director AS isDirector,is_partner AS isPartner
      FROM users WHERE id IN (${placeholders})
    `).bind(...ids).all<CurrentAdminMember>();
    if (currentResult.results.length !== ids.length) {
      return Response.json({ error: "회원을 찾을 수 없습니다." }, { status: 404 });
    }
    const currentById = new Map(currentResult.results.map((member) => [member.id, member]));
    const prepared = validUpdates.map((update) => {
      const current = currentById.get(update.id as number)!;
      const nextLevel = update.level ?? current.level;
      if (!operator.canManageAdmins && (current.level === 10 || nextLevel === 10)) {
        throw Object.assign(new Error("Lv.10 관리자 정보 변경과 지정·해제는 오너 계정만 할 수 있습니다."), { status: 403 });
      }
      const nextIsDirector = update.isDirector ?? Boolean(current.isDirector);
      const nextIsPartner = update.isPartner ?? Boolean(current.isPartner);
      if (nextIsPartner && !nextIsDirector) {
        throw Object.assign(new Error("실장으로 지정된 회원만 제휴회원으로 변경할 수 있습니다."), { status: 409 });
      }
      return { ...update, id: update.id as number, nextLevel, nextIsDirector, nextIsPartner, current };
    });

    const statementGroups = prepared.map((update) => {
      const assignments: string[] = [];
      const bindings: unknown[] = [];
      if (update.nickname !== undefined) { assignments.push("nickname = ?"); bindings.push(update.nickname); }
      if (update.points !== undefined) { assignments.push("points = ?"); bindings.push(update.points); }
      if (update.level !== undefined) {
        assignments.push("level = ?");
        bindings.push(update.level);
      }
      const levelWasChanged = update.level !== undefined && update.level !== update.current.level;
      if (update.levelLocked !== undefined || levelWasChanged) {
        assignments.push("level_locked = ?");
        bindings.push(update.levelLocked === undefined ? 1 : update.levelLocked ? 1 : 0);
      }
      if (update.status !== undefined) { assignments.push("status = ?"); bindings.push(update.status); }
      if (update.isDirector !== undefined) { assignments.push("is_director = ?"); bindings.push(update.isDirector ? 1 : 0); }
      if (update.isPartner !== undefined) { assignments.push("is_partner = ?"); bindings.push(update.isPartner ? 1 : 0); }

      const memberGuard = operator.canManageAdmins ? "" : " AND level <> 10";
      const memberStatements = [env.DB.prepare(`UPDATE users SET ${assignments.join(", ")} WHERE id = ?${memberGuard}`).bind(...bindings, update.id)];
      if (update.current.isDirector && !update.nextIsDirector) {
        memberStatements.push(operator.canManageAdmins
          ? env.DB.prepare("DELETE FROM director_regions WHERE user_id=?").bind(update.id)
          : env.DB.prepare("DELETE FROM director_regions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND level<>10)").bind(update.id, update.id));
      }
      if (update.current.isDirector && !update.nextIsDirector || update.current.isPartner && !update.nextIsPartner) {
        memberStatements.push(operator.canManageAdmins
          ? env.DB.prepare("DELETE FROM featured_vendor_permissions WHERE user_id=?").bind(update.id)
          : env.DB.prepare("DELETE FROM featured_vendor_permissions WHERE user_id=? AND EXISTS (SELECT 1 FROM users WHERE id=? AND level<>10)").bind(update.id, update.id));
      }
      return memberStatements;
    });
    const updateResultIndexes: number[] = [];
    let statementIndex = 0;
    for (const group of statementGroups) {
      updateResultIndexes.push(statementIndex);
      statementIndex += group.length;
    }
    const results = await env.DB.batch(statementGroups.flat());
    if (!operator.canManageAdmins && updateResultIndexes.some((index) => Number(results[index]?.meta.changes ?? 0) !== 1)) {
      return Response.json({ error: "저장 중 관리자 권한이 변경된 회원이 확인되었습니다. 목록을 새로고침한 뒤 다시 시도해 주세요." }, { status: 409 });
    }
    await invalidateMemberSessionsByUserIds(ids);
    return Response.json({ ok: true, updated: prepared.length });
  } catch (error) {
    if (error instanceof Error && "status" in error && typeof error.status === "number") {
      return Response.json({ error: error.message }, { status: error.status });
    }
    const message = error instanceof Error ? error.message : "";
    if (isUniqueConstraintError(error)) return Response.json({ error: "이미 사용 중인 닉네임입니다." }, { status: 409 });
    if (/SQLITE_CONSTRAINT|partner_requires_director|partner.*director|제휴.*실장/i.test(message)) {
      return Response.json({ error: "제휴회원은 반드시 실장으로 함께 지정해야 합니다. 실장·제휴 설정을 확인해 주세요." }, { status: 409 });
    }
    console.error("Admin member update failed", error);
    return Response.json({ error: "회원 정보 저장 중 오류가 발생했습니다." }, { status: 500 });
  }
}
