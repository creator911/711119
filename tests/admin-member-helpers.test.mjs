import assert from "node:assert/strict";
import test from "node:test";
import {
  adminMemberPrefixSearch,
  MAX_ADMIN_MEMBER_SEARCH_CHARACTERS,
  MAX_ADMIN_MEMBER_SEARCH_PATTERN_BYTES,
  MIN_ADMIN_MEMBER_SEARCH_CHARACTERS,
} from "../app/lib/admin-member-search.ts";
import { buildAdminMemberPatch, chunkAdminMemberPatches } from "../app/lib/admin-member-updates.ts";

const baseline = {
  id: 7,
  nickname: "기존회원",
  points: 100,
  level: 3,
  levelLocked: false,
  status: "active",
  isDirector: false,
  isPartner: false,
};

test("admin member patches contain only fields changed from the loaded baseline", () => {
  assert.equal(buildAdminMemberPatch(baseline, baseline), null);
  assert.deepEqual(buildAdminMemberPatch({ ...baseline, nickname: "변경회원" }, baseline), { id: 7, nickname: "변경회원" });
  assert.deepEqual(buildAdminMemberPatch({ ...baseline, points: 250, isDirector: true }, baseline), { id: 7, points: 250, isDirector: true });
  assert.deepEqual(buildAdminMemberPatch({ ...baseline, levelLocked: true }, baseline), { id: 7, levelLocked: true });
  assert.deepEqual(buildAdminMemberPatch({ ...baseline, level: 4, levelLocked: true }, baseline), { id: 7, level: 4, levelLocked: true });
  assert.equal(buildAdminMemberPatch({ ...baseline, points: baseline.points }, baseline), null);
});

test("large admin member edits are split into API-safe batches without losing order", () => {
  const patches = Array.from({ length: 121 }, (_, index) => ({ id: index + 1 }));
  const chunks = chunkAdminMemberPatches(patches, 50);
  assert.deepEqual(chunks.map((chunk) => chunk.length), [50, 50, 21]);
  assert.deepEqual(chunks.flat(), patches);
  assert.throws(() => chunkAdminMemberPatches(patches, 0), /positive integer/);
});

test("admin member prefix patterns escape literals and stay within D1 limits", () => {
  assert.equal(MAX_ADMIN_MEMBER_SEARCH_CHARACTERS, 40);
  assert.equal(MAX_ADMIN_MEMBER_SEARCH_PATTERN_BYTES, 50);
  assert.equal(MIN_ADMIN_MEMBER_SEARCH_CHARACTERS, 2);
  assert.deepEqual(adminMemberPrefixSearch("  Sort%_!  "), { query: "Sort%_!", pattern: "Sort!%!_!!%" });
  assert.equal(adminMemberPrefixSearch("가".repeat(16))?.query, "가".repeat(16));
  assert.equal(adminMemberPrefixSearch("가".repeat(17)), null);
  assert.equal(adminMemberPrefixSearch("%".repeat(25)), null);
  assert.equal(adminMemberPrefixSearch("a".repeat(41)), null);
});
