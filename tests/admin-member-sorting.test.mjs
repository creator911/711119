import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sources = Promise.all([
    readFile(new URL("../app/api/admin/members/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/director-regions/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0034_green_wonder_man.sql", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0035_moaning_zemo.sql", import.meta.url), "utf8"),
]);

test("admin member management keeps server-side sorting, search, and batch saves", async () => {
  const [memberRoute, , consoleSource, styles, orderingMigration, nameMigration] = await sources;

  for (const sort of [
    "created_desc", "created_asc", "points_desc", "points_asc",
    "director_first", "partner_first", "username_asc", "username_desc",
    "nickname_asc", "nickname_desc", "level_desc", "level_asc",
  ]) {
    assert.match(memberRoute, new RegExp(`${sort}:`));
    assert.match(consoleSource, new RegExp(`value: "${sort}"`));
  }

  assert.match(memberRoute, /ORDER BY \$\{MEMBER_SORT_SQL\[sort\]\}/);
  assert.match(memberRoute, /ADMIN_MEMBER_PREFIX_WHERE_SQL/);
  assert.match(memberRoute, /search\.query\.length < MIN_ADMIN_MEMBER_SEARCH_CHARACTERS/);
  assert.doesNotMatch(memberRoute, /LOWER\(username\)|LOWER\(nickname\)|slice\(0, 40\)/);
  assert.match(memberRoute, /hasOwn\(payload, "members"\)/);
  assert.match(memberRoute, /rawUpdates\.length > MAX_ADMIN_MEMBER_BATCH_UPDATES/);
  assert.match(memberRoute, /assignments\.push\("nickname = \?"\)/);
  assert.match(memberRoute, /hasOwn\(value, "levelLocked"\)/);
  assert.match(memberRoute, /const levelWasChanged = update\.level !== undefined && update\.level !== update\.current\.level/);
  assert.match(memberRoute, /assignments\.push\("level_locked = \?"\)/);
  assert.doesNotMatch(memberRoute, /SET nickname = \?, points = \?/);
  assert.match(memberRoute, /await env\.DB\.batch\(statementGroups\.flat\(\)\)/);
  assert.match(memberRoute, /memberGuard = operator\.canManageAdmins \? "" : " AND level <> 10"/);
  assert.match(memberRoute, /DELETE FROM director_regions WHERE user_id=\? AND EXISTS \(SELECT 1 FROM users WHERE id=\? AND level<>10\)/);
  assert.match(memberRoute, /DELETE FROM featured_vendor_permissions WHERE user_id=\? AND EXISTS \(SELECT 1 FROM users WHERE id=\? AND level<>10\)/);
  assert.match(memberRoute, /updateResultIndexes\.some\(\(index\) => Number\(results\[index\]\?\.meta\.changes \?\? 0\) !== 1\)/);
  assert.match(consoleSource, /buildAdminMemberPatch\(member, baseline\)/);
  assert.match(consoleSource, /chunkAdminMemberPatches\(updates, MAX_ADMIN_MEMBER_BATCH_UPDATES\)/);
  assert.match(consoleSource, /body: JSON\.stringify\(\{ members \}\)/);
  assert.match(consoleSource, /onChange=\{\(event\) => changeMemberQuery\(event\.target\.value\)\}/);
  assert.match(consoleSource, /query\.trim\(\)\.length < MIN_ADMIN_MEMBER_SEARCH_CHARACTERS/);
  assert.match(consoleSource, /아이디·닉네임 앞부분 검색/);
  assert.match(consoleSource, /aria-busy=\{memberListBusy\}/);
  assert.match(consoleSource, /레벨 고정/);
  assert.match(consoleSource, /level: Math\.max[\s\S]*levelLocked: true/);
  assert.match(consoleSource, /changeMember\(member\.id, \{ levelLocked: event\.target\.checked \}\)/);
  assert.match(styles, /\.member-toolbar/);
  assert.match(styles, /\.level-lock-toggle/);
  assert.match(orderingMigration, /users_points_id_idx/);
  assert.match(orderingMigration, /users_director_created_id_idx/);
  assert.match(orderingMigration, /users_partner_created_id_idx/);
  assert.match(nameMigration, /users_username_nocase_id_idx/);
  assert.match(nameMigration, /users_nickname_nocase_id_idx/);
});

test("member and director APIs share strict pagination metadata contracts", async () => {
  const [memberRoute, directorRoute] = await sources;

  for (const route of [memberRoute, directorRoute]) {
    assert.match(route, /DEFAULT_ADMIN_PAGE_SIZE/);
    assert.match(route, /positiveInteger\(url\.searchParams\.get\("page"\), 1\)/);
    assert.match(route, /positiveInteger\(url\.searchParams\.get\("pageSize"\), DEFAULT_ADMIN_PAGE_SIZE\)/);
    assert.match(route, /!isAdminPageSize\(requestedPageSize\)/);
    assert.match(route, /Math\.max\(1, Math\.ceil\(total \/ requestedPageSize\)\)/);
    assert.match(route, /Math\.min\(requestedPage, totalPages\)/);
    assert.match(route, /LIMIT \? OFFSET \?/);
    assert.match(route, /\btotal,\s*\n?\s*page,\s*\n?\s*pageSize: requestedPageSize,\s*\n?\s*totalPages,/);
  }

  assert.match(memberRoute, /members: result\.results\.map\(normalizeAdminMemberFlags\)/);
  assert.match(directorRoute, /directors: directors\.results/);
  assert.match(directorRoute, /COUNT\(\*\) FROM director_regions dr WHERE dr\.user_id=u\.id/);
  assert.match(directorRoute, /const requestedUserId = url\.searchParams\.get\("userId"\)/);
  assert.match(directorRoute, /FROM director_regions\s+WHERE user_id=\?/);
  assert.match(directorRoute, /return privateJson\(\{ userId, assignments: assignments\.results \}\)/);
  assert.match(directorRoute, /WHERE EXISTS \(SELECT 1 FROM users WHERE id=\? AND is_director=1 AND status='active'\)/);
  assert.match(directorRoute, /results\.slice\(1\)\.some\(\(result\) => Number\(result\.meta\.changes \?\? 0\) !== 1\)/);
});

test("admin UI wires both paginated lists and locks navigation while dirty", async () => {
  const [, , consoleSource, styles] = await sources;

  assert.equal((consoleSource.match(/useState<AdminPageSize>\(DEFAULT_ADMIN_PAGE_SIZE\)/g) ?? []).length, 2);
  assert.match(consoleSource, /ADMIN_PAGE_SIZES\.map\(\(pageSize\) =>/);
  assert.match(consoleSource, /groupedAdminPageNumbers\(memberPage, memberTotalPages\)/);
  assert.match(consoleSource, /groupedAdminPageNumbers\(directorPage, directorTotalPages\)/);
  assert.match(consoleSource, /page: String\(memberPage\), pageSize: String\(memberPageSize\)/);
  assert.match(consoleSource, /page: String\(directorPage\), pageSize: String\(directorPageSize\)/);
  assert.match(consoleSource, /fetch\(`\/api\/admin\/members\?\$\{search\.toString\(\)\}`/);
  assert.match(consoleSource, /fetch\(`\/api\/admin\/director-regions\?\$\{search\.toString\(\)\}`/);
  assert.match(consoleSource, /fetch\(`\/api\/admin\/director-regions\?userId=\$\{member\.id\}`/);
  assert.match(consoleSource, /const requestKey = `\$\{query\.trim\(\)\}\\u0000\$\{memberSort\}\\u0000\$\{memberPage\}\\u0000\$\{memberPageSize\}`/);
  assert.match(consoleSource, /const requestKey = `\$\{directorPage\}\\u0000\$\{directorPageSize\}`/);
  assert.match(consoleSource, /const memberRangeStart = memberTotal \? \(memberPage - 1\) \* memberPageSize \+ 1 : 0/);
  assert.match(consoleSource, /const directorRangeStart = directorTotal \? \(directorPage - 1\) \* directorPageSize \+ 1 : 0/);

  assert.match(consoleSource, /if \(!signedIn \|\| tab !== "members" \|\| dirtyMemberIds\.length \|\| memberListLoadedKey === requestKey \|\| \(query\.trim\(\)\.length > 0/);
  assert.match(consoleSource, /if \(!signedIn \|\| tab !== "directors" \|\| dirtyDirectorIds\.length \|\| directorListLoadedKey === requestKey\) return/);
  assert.match(consoleSource, /AdminPageSizeButtons value=\{memberPageSize\} disabled=\{Boolean\(dirtyMemberIds\.length\) \|\| memberListBusy \|\| submitting\}/);
  assert.match(consoleSource, /AdminPagination page=\{memberPage\}[\s\S]*?disabled=\{Boolean\(dirtyMemberIds\.length\) \|\| memberListBusy \|\| submitting\}/);
  assert.match(consoleSource, /const directorNavigationLocked = Boolean\(dirtyDirectorIds\.length\) \|\| savingDirectorId !== null \|\| directorAssignmentsLoadingId !== null \|\| directorListBusy/);
  assert.match(consoleSource, /AdminPageSizeButtons value=\{directorPageSize\} disabled=\{directorNavigationLocked\}/);
  assert.match(consoleSource, /AdminPagination page=\{directorPage\}[\s\S]*?disabled=\{directorNavigationLocked\}/);
  assert.match(consoleSource, /setMemberPageSize\(pageSize\); setMemberPage\(1\)/);
  assert.match(consoleSource, /setDirectorPageSize\(pageSize\); setDirectorPage\(1\)/);
  assert.match(consoleSource, /변경 저장 후 검색·정렬·페이지 이동이 가능합니다/);
  assert.match(consoleSource, /변경 저장 후 표시 개수·페이지 이동이 가능합니다/);
  assert.match(consoleSource, /if \(dirtyDirectorIdsRef\.current\.length\) \{\s*directorRefreshPendingRef\.current = true;\s*\} else setDirectorListLoadedKey\(""\)/);
  assert.match(consoleSource, /dirtyDirectorIdsRef\.current = next;\s*setDirtyDirectorIds\(next\)/);
  assert.match(consoleSource, /!remainingDirtyIds\.length && directorRefreshPendingRef\.current/);
  assert.match(consoleSource, /value=\{member\.isDirector \? "director" : "member"\} disabled=\{protectedAdmin \|\| submitting\}/);
  assert.match(consoleSource, /value=\{member\.isPartner \? "partner" : "member"\} disabled=\{protectedAdmin \|\| submitting \|\|/);
  assert.match(consoleSource, /<small>최근 가입 순<\/small>/);
  assert.doesNotMatch(consoleSource, /<small>최근 지정 순<\/small>/);

  assert.match(consoleSource, /firstPage - 1/);
  assert.match(consoleSource, /lastPage \+ 1/);
  assert.match(consoleSource, /이전 20/);
  assert.match(consoleSource, /다음 20/);
  assert.match(styles, /\.admin-page-size-buttons/);
  assert.match(styles, /\.admin-pagination/);
});
