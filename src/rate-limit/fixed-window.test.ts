import assert from "node:assert/strict";
import { test } from "node:test";
import { createFixedWindowLimiter } from "./fixed-window.js";

function setup() {
  let time = 0;
  const limiter = createFixedWindowLimiter({
    windowMs: 10_000,
    maxRequests: 5,
    now: () => time,
  });
  return { limiter, setTime: (value: number) => { time = value; } };
}

function exhaust(limiter: ReturnType<typeof createFixedWindowLimiter>, key: string) {
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(limiter.consume(key), { allowed: true });
  }
}

test("allows five requests and rejects further requests in the same window", () => {
  const { limiter } = setup();
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 10_000 });
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 10_000 });
});

test("clients have independent quotas and window start times", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(5_000);
  exhaust(limiter, "bob");
  setTime(10_000);
  assert.deepEqual(limiter.consume("alice"), { allowed: true });
  assert.deepEqual(limiter.consume("bob"), { allowed: false, retryAfterMs: 5_000 });
});

test("rejections do not extend the window; the quota resets at the exact boundary", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(9_999);
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 1 });
  setTime(10_000);
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 10_000 });
});

test("a request after a long idle period starts a new window without cleanup", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(35_000);
  exhaust(limiter, "alice");
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 10_000 });
});

test("cleanup removes expired entries and preserves active quotas", () => {
  const { limiter, setTime } = setup();
  exhaust(limiter, "alice");
  setTime(5_000);
  exhaust(limiter, "bob");
  setTime(9_999);
  assert.equal(limiter.cleanup(), 0);
  setTime(10_000);
  assert.equal(limiter.cleanup(), 1);
  assert.equal(limiter.cleanup(), 0);
  assert.deepEqual(limiter.consume("bob"), { allowed: false, retryAfterMs: 5_000 });
  exhaust(limiter, "alice");
});

test("honors custom limits and window durations", () => {
  const limiter = createFixedWindowLimiter({ windowMs: 250, maxRequests: 1, now: () => 0 });
  assert.deepEqual(limiter.consume("alice"), { allowed: true });
  assert.deepEqual(limiter.consume("alice"), { allowed: false, retryAfterMs: 250 });
});

test("rejects invalid limits and durations", () => {
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => createFixedWindowLimiter({ windowMs: value, maxRequests: 5 }), RangeError);
    assert.throws(() => createFixedWindowLimiter({ windowMs: 10_000, maxRequests: value }), RangeError);
  }
});
