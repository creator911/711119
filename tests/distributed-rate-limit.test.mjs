import assert from "node:assert/strict";
import test from "node:test";
import { consumeDistributedRateLimit } from "../app/lib/distributed-rate-limit.ts";

test("distributed rate limits hash subjects and enforce a fixed window", async () => {
  const keys = [];
  let count = 0;
  const cache = {
    async incrementBy(key, amount, ttlSeconds) {
      keys.push({ key, amount, ttlSeconds });
      count += amount;
      return count;
    },
  };
  const first = await consumeDistributedRateLimit(cache, "login", "198.51.100.4", 2, 60);
  const second = await consumeDistributedRateLimit(cache, "login", "198.51.100.4", 2, 60);
  const third = await consumeDistributedRateLimit(cache, "login", "198.51.100.4", 2, 60);
  assert.equal(first.allowed, true);
  assert.equal(second.remaining, 0);
  assert.equal(third.allowed, false);
  assert.equal(keys[0].ttlSeconds, 60);
  assert.doesNotMatch(keys[0].key, /198\.51\.100\.4/);
});

test("database-backed safeguards remain available during a Valkey failover", async () => {
  const cache = { incrementBy: async () => { throw new Error("cache unavailable"); } };
  assert.equal(await consumeDistributedRateLimit(cache, "login", "subject", 1, 60), null);
  assert.equal(await consumeDistributedRateLimit(null, "login", "subject", 1, 60), null);
});
