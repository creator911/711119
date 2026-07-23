import assert from "node:assert/strict";
import test from "node:test";
import { createConcurrencyGate } from "../app/lib/upload-concurrency.ts";

test("upload parsing concurrency is bounded and releases exactly once", () => {
  const gate = createConcurrencyGate(2);
  const releaseOne = gate.tryAcquire();
  const releaseTwo = gate.tryAcquire();
  assert.equal(typeof releaseOne, "function");
  assert.equal(typeof releaseTwo, "function");
  assert.equal(gate.active(), 2);
  assert.equal(gate.tryAcquire(), null);
  releaseOne();
  releaseOne();
  assert.equal(gate.active(), 1);
  const releaseThree = gate.tryAcquire();
  assert.equal(typeof releaseThree, "function");
  releaseTwo();
  releaseThree();
  assert.equal(gate.active(), 0);
});
