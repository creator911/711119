import assert from "node:assert/strict";
import test from "node:test";
import {
  ADMIN_PAGE_GROUP_SIZE,
  ADMIN_PAGE_SIZES,
  DEFAULT_ADMIN_PAGE_SIZE,
  groupedAdminPageNumbers,
  isAdminPageSize,
} from "../app/lib/admin-pagination.ts";

const pages = (first, last) => Array.from({ length: last - first + 1 }, (_, index) => first + index);

test("admin pagination accepts only the three supported view sizes", () => {
  assert.equal(DEFAULT_ADMIN_PAGE_SIZE, 10);
  assert.deepEqual(ADMIN_PAGE_SIZES, [10, 100, 1000]);

  for (const pageSize of ADMIN_PAGE_SIZES) assert.equal(isAdminPageSize(pageSize), true);
  for (const pageSize of [0, 1, 9, 11, 50, 99, 101, 999, 1001, Number.NaN, Number.POSITIVE_INFINITY]) {
    assert.equal(isAdminPageSize(pageSize), false);
  }
});

test("admin page numbers stay in fixed groups of twenty", () => {
  assert.equal(ADMIN_PAGE_GROUP_SIZE, 20);
  assert.deepEqual(groupedAdminPageNumbers(1, 75), pages(1, 20));
  assert.deepEqual(groupedAdminPageNumbers(20, 75), pages(1, 20));
  assert.deepEqual(groupedAdminPageNumbers(21, 75), pages(21, 40));
  assert.deepEqual(groupedAdminPageNumbers(40, 75), pages(21, 40));
  assert.deepEqual(groupedAdminPageNumbers(41, 75), pages(41, 60));
  assert.deepEqual(groupedAdminPageNumbers(75, 75), pages(61, 75));
});

test("admin page groups clamp invalid positions and keep partial groups", () => {
  assert.deepEqual(groupedAdminPageNumbers(1, 1), [1]);
  assert.deepEqual(groupedAdminPageNumbers(0, 45), pages(1, 20));
  assert.deepEqual(groupedAdminPageNumbers(999, 45), pages(41, 45));
  assert.deepEqual(groupedAdminPageNumbers(45, 45), pages(41, 45));
});
