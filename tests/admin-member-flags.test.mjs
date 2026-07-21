import assert from "node:assert/strict";
import test from "node:test";
import { normalizeAdminMemberFlags } from "../app/lib/admin-member-flags.ts";

test("normalizes every admin member role flag combination to booleans", () => {
  const combinations = [
    { raw: [0, 0], expected: [false, false] },
    { raw: [1, 0], expected: [true, false] },
    { raw: [1, 1], expected: [true, true] },
    { raw: [false, true], expected: [false, true] },
  ];

  for (const { raw, expected } of combinations) {
    const normalized = normalizeAdminMemberFlags({ id: 7, isDirector: raw[0], isPartner: raw[1] });
    assert.equal(normalized.id, 7);
    assert.equal(normalized.isDirector, expected[0]);
    assert.equal(normalized.isPartner, expected[1]);
    assert.equal(typeof normalized.isDirector, "boolean");
    assert.equal(typeof normalized.isPartner, "boolean");
  }
});
