import assert from "node:assert/strict";
import { test } from "node:test";
import { createTokenBucketLimiter } from "./token-bucket.js";

function setup() {
  let time = 0;
  const limiter = createTokenBucketLimiter({
    capacity: 5,
    refillIntervalMs: 2_000,
    now: () => time,
  });
  return { limiter, setTime: (value: number) => { time = value; } };
}

function exhaust(limiter: ReturnType<typeof createTokenBucketLimiter>, key: string) {
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(limiter.consume(key), { allowed: true });
  }
}

test("token bucket allows an initial burst and keeps clients independent", () => {
  const { limiter } = setup();
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 2_000 });
  exhaust(limiter, "bob");
});

test("token bucket preserves partial refill through rejected requests", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(1_000);
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 1_000 });
  setTime(1_500);
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 500 });
  setTime(2_000);
  assert.deepEqual(limiter.consume("alice"), { allowed: true });
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 2_000 });
});

test("token bucket never accumulates more than its capacity", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(100_000);
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 2_000 });
});

test("token bucket cleanup preserves partial buckets and removes full ones", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(5_000);
  exhaust(limiter, "bob");
  setTime(10_000);
  assert.equal(limiter.cleanup(), 1);
  assert.equal(limiter.cleanup(), 0);
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("bob"), { allowed: true });
  assert.deepEqual(limiter.consume("bob"), { allowed: true });
  assert.deepEqual(limiter.consume("bob"), { allowed: false, retryAfterMs: 1_000 });
});

test("token bucket does not earn extra tokens when the clock moves backward", () => {
  const { limiter, setTime } = setup();
  setTime(1_000);
  exhaust(limiter, "alice");
  setTime(0);
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 3_000 });
  setTime(3_000);
  assert.deepEqual(limiter.consume("alice"), { allowed: true });
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 2_000 });
});

test("token bucket rejects invalid configuration", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createTokenBucketLimiter({ capacity: value, refillIntervalMs: 2_000 }), RangeError);
    assert.throws(() => createTokenBucketLimiter({ capacity: 5, refillIntervalMs: value }), RangeError);
  }
});
