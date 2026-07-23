import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("attendance screen avoids a full-history ranking aggregate at large scale", async () => {
  const [route, schema, component] = await Promise.all([
    readFile(new URL("../app/api/attendance/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/AttendanceModal.tsx", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(route, /GROUP BY a\.user_id, u\.nickname/);
  assert.match(route, /ORDER BY a\.created_at ASC,a\.id ASC LIMIT 101/);
  assert.match(route, /nextEntriesCursor/);
  assert.match(route, /SELECT COUNT\(\*\) AS count FROM attendance WHERE attendance_date=\?/);
  assert.match(route, /ranking:\s*\[\]/);
  assert.match(schema, /uniqueIndex\("attendance_user_date_unique"\)/);
  assert.match(schema, /index\("attendance_date_user_idx"\)/);
  assert.match(schema, /index\("attendance_date_created_id_idx"\)/);
  assert.match(component, /current && current\.today === result\.today/);
  assert.match(component, /data\?\.today && data\.today !== result\.today/);
  assert.match(component, /result\.today\.split\("-"\)\.map\(Number\)/);
  assert.match(component, /setYear\(nextYear\)/);
  assert.match(component, /setMonthIndex\(nextMonth - 1\)/);
  assert.match(component, /setData\(null\)/);
  assert.match(component, /attendanceRequestSequenceRef/);
  assert.match(component, /sequence === attendanceRequestSequenceRef\.current/);
});
