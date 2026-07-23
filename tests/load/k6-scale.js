import http from "k6/http";
import { check, sleep } from "k6";
import { Rate, Trend } from "k6/metrics";

const target = (__ENV.LOAD_TEST_TARGET || "http://127.0.0.1:3000").replace(/\/+$/, "");
const targetHost = new URL(target).hostname;
if (!["127.0.0.1", "localhost"].includes(targetHost) && __ENV.LOAD_TEST_CONFIRM !== targetHost) {
  throw new Error(`Set LOAD_TEST_CONFIRM=${targetHost} to authorize load against this host`);
}

const readLatency = new Trend("nara_read_latency", true);
const writeLatency = new Trend("nara_write_latency", true);
const requestFailures = new Rate("nara_request_failures");
const sessionCookie = __ENV.LOAD_TEST_SESSION_COOKIE || "";
const runFullScale = __ENV.LOAD_TEST_FULL_SCALE === "1";
const sustainedUsers = Number(__ENV.LOAD_TEST_USERS || (runFullScale ? 10000 : 100));
const sustainedDuration = __ENV.LOAD_TEST_DURATION || (runFullScale ? "60m" : "1m");
const spikeUsers = Number(__ENV.LOAD_TEST_SPIKE_USERS || (runFullScale ? 20000 : 0));
const spikeDuration = __ENV.LOAD_TEST_SPIKE_DURATION || (runFullScale ? "5m" : "0s");
const spikeStart = __ENV.LOAD_TEST_SPIKE_START || sustainedDuration;
const writeUsers = Number(__ENV.LOAD_TEST_WRITE_USERS || 0);
const writeDuration = __ENV.LOAD_TEST_WRITE_DURATION || sustainedDuration;

const scenarios = {};
if (sustainedUsers > 0) {
  scenarios.sustained_reads = {
    executor: "constant-vus",
    exec: "readScenario",
    vus: sustainedUsers,
    duration: sustainedDuration,
    gracefulStop: "30s",
  };
}
if (spikeUsers > 0 && spikeDuration !== "0s") {
  scenarios.spike_reads = {
    executor: "constant-vus",
    exec: "readScenario",
    vus: spikeUsers,
    duration: spikeDuration,
    startTime: spikeStart,
    gracefulStop: "30s",
  };
}
if (writeUsers > 0) {
  if (!sessionCookie) throw new Error("LOAD_TEST_SESSION_COOKIE is required for write scenarios");
  scenarios.concurrent_attendance = {
    executor: "constant-vus",
    exec: "writeScenario",
    vus: writeUsers,
    duration: writeDuration,
    gracefulStop: "30s",
  };
}
if (!Object.keys(scenarios).length) throw new Error("At least one load scenario must have users greater than zero");

export const options = {
  scenarios,
  thresholds: {
    nara_read_latency: ["p(95)<500"],
    nara_write_latency: ["p(95)<1500"],
    nara_request_failures: ["rate<0.01"],
  },
  noConnectionReuse: false,
  discardResponseBodies: true,
};

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

function headers() {
  return sessionCookie ? { Cookie: `cn_session=${sessionCookie}` } : {};
}

export function readScenario() {
  const path = publicReads[Math.floor(Math.random() * publicReads.length)];
  const response = http.get(`${target}${path}`, { headers: headers(), tags: { operation: "read" } });
  readLatency.add(response.timings.duration);
  requestFailures.add(response.status >= 500);
  check(response, { "read response is not a server error": (value) => value.status < 500 });
  sleep(Math.random() * 0.2);
}

export function writeScenario() {
  const response = http.post(
    `${target}/api/attendance`,
    JSON.stringify({ greeting: "동시성 검증 출석" }),
    {
      headers: { ...headers(), "Content-Type": "application/json" },
      tags: { operation: "write" },
    },
  );
  writeLatency.add(response.timings.duration);
  requestFailures.add(response.status >= 500);
  check(response, {
    "attendance is accepted or already committed": (value) => [200, 409].includes(value.status),
  });
  sleep(Math.random() * 0.5);
}
