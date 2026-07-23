import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { memberLevelProgressPercent } from "../app/lib/member-level.ts";

const target = { level: 2, attendance: 5, posts: 5, comments: 10 };

test("level progress gives each requirement at most one third", () => {
  assert.equal(memberLevelProgressPercent({ attendance: 0, posts: 0, comments: 50 }, target), 33.3);
  assert.equal(memberLevelProgressPercent({ attendance: 50, posts: 0, comments: 0 }, target), 33.3);
  assert.equal(memberLevelProgressPercent({ attendance: 0, posts: 50, comments: 0 }, target), 33.3);
  assert.equal(memberLevelProgressPercent({ attendance: 5, posts: 5, comments: 10 }, target), 100);
  assert.equal(memberLevelProgressPercent({ attendance: 50, posts: 50, comments: 100 }, target), 100);
});

test("level progress combines partial attendance, posts, and comments", () => {
  assert.equal(memberLevelProgressPercent({ attendance: 2.5, posts: 2.5, comments: 5 }, target), 50);
  assert.equal(memberLevelProgressPercent({ attendance: 5, posts: 0, comments: 5 }, target), 50);
});

test("level guide reloads admin settings and current member activity whenever opened", async () => {
  const [route, modal, portal, styles] = await Promise.all([
    readFile(new URL("../app/api/member-level-progress/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/LevelProgressModal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(route, /memberFromSession\(request\)/);
  assert.match(route, /refreshAutomaticMemberLevelFromProgressRow\(env\.DB, loadedRow, settings\)/);
  assert.equal(route.match(/loadMemberLevelProgressRow\(env\.DB/g)?.length, 1);
  assert.match(route, /loadPointSettings\(env\.DB\)/);
  assert.match(route, /requirement\.level === row\.level \+ 1/);
  assert.match(modal, /fetch\("\/api\/member-level-progress", \{ cache: "no-store" \}\)/);
  assert.match(modal, /출석일 \{data\.remaining\.attendance\}일/);
  assert.match(modal, /role="dialog" aria-modal="true"/);
  assert.match(modal, /event\.key === "Escape"/);
  assert.match(modal, /event\.key !== "Tab"/);
  assert.match(modal, /!dialog\.contains\(activeElement\) \|\| !focusable\.includes\(activeElement\)/);
  assert.match(modal, /document\.addEventListener\("focusin", recoverFocus\)/);
  assert.match(modal, /previousFocus\?\.isConnected/);
  assert.doesNotMatch(modal, /LEVEL UP BENEFIT|상점 이용 가능 품목이 증가합니다/);
  assert.doesNotMatch(styles, /\.level-progress-benefit/);
  assert.match(portal, /<button type="button" className="member-level"[\s\S]*?aria-haspopup="dialog"/);
  assert.match(portal, /levelProgressOpen && viewer && <LevelProgressModal/);
  assert.match(styles, /\.level-progress-track>span/);
  assert.match(styles, /\.member-level:hover/);
});
