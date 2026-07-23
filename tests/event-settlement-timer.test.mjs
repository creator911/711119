import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("VPS timer settles weekly and monthly events without visitor traffic", async () => {
  const [service, timer, installer] = await Promise.all([
    readFile(new URL("../deploy/nara001-event-settlement.service", import.meta.url), "utf8"),
    readFile(new URL("../deploy/nara001-event-settlement.timer", import.meta.url), "utf8"),
    readFile(new URL("../deploy/install-server.sh", import.meta.url), "utf8"),
  ]);
  assert.match(service, /Type=oneshot/);
  assert.match(service, /127\.0\.0\.1:3000\/api\/events\/leaderboard\?period=weekly/);
  assert.match(service, /127\.0\.0\.1:3000\/api\/events\/leaderboard\?period=monthly/);
  assert.match(service, /--fail[\s\S]*--max-time 30/);
  assert.match(timer, /OnUnitActiveSec=5min/);
  assert.match(timer, /Persistent=true/);
  assert.match(installer, /nara001-event-settlement\.service/);
  assert.match(installer, /enable --now[\s\S]*nara001-event-settlement\.timer/);
});
