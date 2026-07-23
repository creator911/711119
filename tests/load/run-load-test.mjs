const target = new URL(process.env.LOAD_TEST_TARGET || "http://127.0.0.1:3000");
const normalUsers = Math.max(1, Number(process.env.LOAD_TEST_USERS || 100));
const normalSeconds = Math.max(1, Number(process.env.LOAD_TEST_SECONDS || 60));
const spikeUsers = Math.max(0, Number(process.env.LOAD_TEST_SPIKE_USERS || 0));
const spikeSeconds = Math.max(0, Number(process.env.LOAD_TEST_SPIKE_SECONDS || 0));
const mutationEnabled = process.env.LOAD_TEST_MUTATIONS === "1";
const sessionCookie = process.env.LOAD_TEST_SESSION_COOKIE || "";

if (!["127.0.0.1", "localhost"].includes(target.hostname)
  && process.env.LOAD_TEST_CONFIRM !== target.hostname) {
  throw new Error(`Set LOAD_TEST_CONFIRM=${target.hostname} to authorize load against this host`);
}

const publicReads = [
  "/api/posts?category=community&sort=latest&limit=30",
  "/api/posts?category=reviews&sort=latest&limit=30",
  "/api/posts?category=notices&sort=latest&limit=30",
  "/api/posts?category=events&sort=latest&limit=30",
  "/api/vendor-posts?limit=30",
  "/api/featured-vendors",
  "/api/events/leaderboard?period=weekly",
  "/api/announcements/active",
];
const privateReads = ["/api/mypage", "/api/attendance", "/api/support?kind=support"];
const latencies = [];
const statuses = new Map();
let requests = 0;
let failures = 0;

function percentile(values, percent) {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percent))];
}

function pick(items) {
  return items[Math.floor(Math.random() * items.length)];
}

async function requestOnce(signal) {
  const roll = Math.random();
  const privateRequest = roll >= 0.65 && roll < 0.80 && sessionCookie;
  const path = privateRequest ? pick(privateReads) : pick(publicReads);
  const startedAt = performance.now();
  try {
    const response = await fetch(new URL(path, target), {
      signal,
      headers: sessionCookie ? { Cookie: `cn_session=${sessionCookie}` } : undefined,
    });
    await response.arrayBuffer();
    const elapsed = performance.now() - startedAt;
    latencies.push(elapsed);
    requests += 1;
    statuses.set(response.status, (statuses.get(response.status) ?? 0) + 1);
    if (response.status >= 500) failures += 1;
  } catch {
    requests += 1;
    failures += 1;
  }

  if (mutationEnabled && roll >= 0.95 && sessionCookie) {
    // Mutation scenarios are intentionally opt-in and must target disposable
    // staging accounts. The production-safe default performs reads only.
    await fetch(new URL("/api/attendance", target), {
      method: "POST",
      signal,
      headers: { Cookie: `cn_session=${sessionCookie}`, "Content-Type": "application/json" },
      body: JSON.stringify({ greeting: "부하검증 출석" }),
    }).catch(() => undefined);
  }
}

async function phase(users, seconds, name) {
  if (!users || !seconds) return;
  console.log(`${name}: ${users} virtual users for ${seconds}s`);
  const controller = new AbortController();
  const deadline = Date.now() + seconds * 1_000;
  await Promise.all(Array.from({ length: users }, async () => {
    while (Date.now() < deadline) await requestOnce(controller.signal);
  }));
  controller.abort();
}

await phase(normalUsers, normalSeconds, "sustained");
await phase(spikeUsers, spikeSeconds, "spike");

const report = {
  target: target.origin,
  requests,
  failures,
  errorRate: requests ? failures / requests : 0,
  requestsPerSecond: requests / Math.max(1, normalSeconds + spikeSeconds),
  latencyMs: {
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
    max: latencies.length ? Math.max(...latencies) : 0,
  },
  statuses: Object.fromEntries([...statuses].sort(([left], [right]) => left - right)),
};
console.log(JSON.stringify(report, null, 2));
if (report.errorRate > 0.01 || report.latencyMs.p95 > 500) process.exitCode = 1;
