import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { horizontalScrollAvailability, horizontalScrollStep, horizontalScrollTarget } from "../app/lib/horizontal-scroll.ts";

test("가로 목록 화살표는 실제로 넘길 수 있는 방향에만 표시된다", () => {
  assert.deepEqual(horizontalScrollAvailability(0, 400, 400), { canScrollLeft: false, canScrollRight: false });
  assert.deepEqual(horizontalScrollAvailability(0, 320, 900), { canScrollLeft: false, canScrollRight: true });
  assert.deepEqual(horizontalScrollAvailability(260, 320, 900), { canScrollLeft: true, canScrollRight: true });
  assert.deepEqual(horizontalScrollAvailability(580, 320, 900), { canScrollLeft: true, canScrollRight: false });
});

test("화살표 한 번으로 모바일 목록의 대부분을 자연스럽게 넘긴다", () => {
  assert.equal(horizontalScrollStep(320), 262);
  assert.equal(horizontalScrollStep(180), 180);
});

test("오른쪽 화살표는 현재 오른쪽에서 잘린 첫 탭부터 보여준다", () => {
  const items = [
    { left: 0, width: 65 },
    { left: 65, width: 90 },
    { left: 155, width: 100 },
    { left: 255, width: 80 },
    { left: 335, width: 80 },
    { left: 415, width: 100 },
    { left: 515, width: 100 },
  ];
  assert.equal(horizontalScrollTarget(1, 0, 380, 900, items), 335);
  assert.equal(horizontalScrollTarget(-1, 335, 380, 900, items), 0);
});

test("업종·대지역·메인 인기지역이 같은 조건부 원형 화살표를 사용한다", async () => {
  const [portal, styles] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /<HorizontalScrollRow className="area-major-row" label="큰 지역 선택">/);
  assert.match(portal, /<HorizontalScrollRow className="vendor-category-row" label="업종 선택">/);
  assert.match(portal, /availability\.canScrollLeft && <button[^>]+previous/);
  assert.match(portal, /availability\.canScrollRight && <button[^>]+next/);
  assert.match(styles, /\.horizontal-scroll-arrow\s*\{[^}]*border-radius:50%;/);
});
