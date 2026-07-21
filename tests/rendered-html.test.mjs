import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const projectRoot = new URL("../", import.meta.url);

test("출장나라 메인 화면과 배포 산출물을 구성한다", async () => {
  const [page, layout, portal] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    access(new URL("../dist/server/index.js", import.meta.url)),
  ]);
  assert.match(page, /title:\s*SITE_TITLE/);
  assert.match(layout, /siteName:\s*SITE_NAME/);
  assert.match(layout, /description:\s*SITE_DESCRIPTION/);
  assert.match(portal, /원하는 지역과 업체를/);
  assert.doesNotMatch(portal, /믿을 수 있는 선택|업체 둘러보기/);
  assert.match(portal, /추천 업체/);
  assert.match(portal, /로그인/);
  assert.match(portal, /회원가입/);
  assert.doesNotMatch(page + layout + portal, /codex-preview|Your site is taking shape|Codex is working/i);
});

test("완성된 사이트에서 임시 미리보기 자산을 제거했다", async () => {
  const [page, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<Portal \/>/);
  assert.match(layout, /site-metadata/);
  assert.doesNotMatch(page + layout + packageJson, /codex-preview|react-loading-skeleton|SkeletonPreview/);
  await assert.rejects(access(new URL("../app/_sites-preview", projectRoot)));
});

test("제휴 슬롯 저장 버튼은 흰 배경에서 검은 글자로 표시된다", async () => {
  const adminStyles = await readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8");
  assert.match(adminStyles, /\.admin-tr \.affiliate-slot-save button\s*\{[^}]*background:#fff;[^}]*color:#111;/);
});

test("운영 콘솔에서 공용 메인페이지 도메인을 관리한다", async () => {
  const [admin, route, styles, migration] = await Promise.all([
    readFile(new URL("../app/admin/AdminConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/admin/main-domain/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../drizzle/0025_black_vampiro.sql", import.meta.url), "utf8"),
  ]);
  assert.match(admin, /<span>11<\/span>메인페이지 도메인/);
  assert.match(admin, /fetch\("\/api\/admin\/main-domain"/);
  assert.match(admin, /모든 기기에 동일하게 적용됩니다/);
  assert.match(route, /ON CONFLICT\(key\) DO UPDATE/);
  assert.match(route, /CREATE TABLE IF NOT EXISTS site_settings/);
  assert.match(route, /adminSession\(request, env\)/);
  assert.match(styles, /\.admin-domain-panel/);
  assert.match(migration, /CREATE TABLE `site_settings`/);
  assert.match(migration, /https:\/\/nara001\.co\.kr/);
});

test("업체정보 행 전체가 열리고 게시글 목록은 밝은 줄무늬로 구분된다", async () => {
  const [portal, styles] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /<button type="button" className="vendor-board-row"[^>]+onClick=\{\(\) => void openPost\(post\)\}/);
  assert.match(portal, /aria-label=\{`\$\{post\.industry\} \$\{post\.region\} \$\{post\.district\} \$\{stripRichTitle\(post\.title\)\} 업체정보 보기`\}/);
  assert.doesNotMatch(portal, /className="vendor-board-subject"><button/);
  assert.match(styles, /\.vendor-board-list>\.vendor-board-row:nth-child\(even\)\s*\{\s*background:#f6f6f6;/);
  assert.match(styles, /\.forum-table>\.forum-row:not\(\.forum-head\):nth-child\(odd\)\s*\{\s*background:#f6f6f6;/);
});

test("모바일 메인에서 실시간 후기와 커뮤니티 카드를 모두 표시한다", async () => {
  const [portal, styles] = await Promise.all([
    readFile(new URL("../app/components/Portal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(portal, /<BoardPreview kind="reviews" title="실시간 후기"/);
  assert.match(portal, /<BoardPreview kind="community" title="커뮤니티"/);
  assert.doesNotMatch(styles, /\.board-card:nth-child\(2\)\s*\{[^}]*display:none/);
});
