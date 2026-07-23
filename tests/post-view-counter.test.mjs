import assert from "node:assert/strict";
import test from "node:test";
import { createPostViewCounter } from "../app/lib/post-view-counter.ts";

function fakeDatabase({ fail = false } = {}) {
  const writes = [];
  const database = {
    prepare(query) {
      assert.match(query, /UPDATE posts SET views=views\+\?/);
      return { query, bind: (...values) => ({ query, values, bind() { throw new Error("already bound"); } }) };
    },
    async batch(statements) {
      if (fail) throw new Error("database unavailable");
      writes.push(statements.map((statement) => statement.values));
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
  return { database, writes, recover: () => { fail = false; } };
}

test("post view counter coalesces repeated views into one update per post", async () => {
  const { database, writes } = fakeDatabase();
  const counter = createPostViewCounter({ flushIntervalMs: 60_000, flushThreshold: 100 });
  await Promise.all([
    counter.record(database, 7), counter.record(database, 7), counter.record(database, 7),
    counter.record(database, 8), counter.record(database, 8),
  ]);
  assert.equal(writes.length, 0);
  await counter.flush(database);
  assert.deepEqual(writes, [[[3, 7], [2, 8]]]);
  assert.equal(counter.pending(database).total, 0);
});

test("post view counter retains failed writes and retries without losing counts", async () => {
  const target = fakeDatabase({ fail: true });
  const errors = [];
  const counter = createPostViewCounter({ flushIntervalMs: 60_000, flushThreshold: 100, maxBufferedViews: 100, onFlushError: (error) => errors.push(error) });
  await counter.record(target.database, 1);
  await counter.record(target.database, 1);
  await counter.record(target.database, 2);
  await assert.rejects(counter.flush(target.database), /database unavailable/);
  assert.deepEqual([...counter.pending(target.database).posts], [[1, 2], [2, 1]]);
  target.recover();
  await counter.flush(target.database);
  assert.deepEqual(target.writes, [[[2, 1], [1, 2]]]);
  assert.equal(counter.pending(target.database).total, 0);
  assert.equal(errors.length, 0);
});

test("post view counter validates identifiers before buffering", async () => {
  const { database } = fakeDatabase();
  const counter = createPostViewCounter();
  await assert.rejects(counter.record(database, 0), /positive integer/);
  await assert.rejects(counter.record(database, 1.5), /positive integer/);
  assert.equal(counter.pending(database).total, 0);
});
