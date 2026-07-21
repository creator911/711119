import assert from "node:assert/strict";
import test from "node:test";
import { visiblePageNumbers } from "../app/lib/board-pagination.ts";

test("페이지 번호는 현재 위치 주변 최대 5개만 표시한다", () => {
  assert.deepEqual(visiblePageNumbers(1, 1), [1]);
  assert.deepEqual(visiblePageNumbers(1, 7), [1, 2, 3, 4, 5]);
  assert.deepEqual(visiblePageNumbers(4, 7), [2, 3, 4, 5, 6]);
  assert.deepEqual(visiblePageNumbers(7, 7), [3, 4, 5, 6, 7]);
  assert.deepEqual(visiblePageNumbers(99, 3), [1, 2, 3]);
});
