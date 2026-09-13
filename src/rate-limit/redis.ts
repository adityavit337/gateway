import type {
  AsyncRateLimiter,
  RateLimitDecision,
} from "./types.js";

interface RedisEvalClient {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}

interface BaseRedisRateLimiterOptions {
  keyPrefix?: string;
}

interface RedisFixedWindowOptions extends BaseRedisRateLimiterOptions {
  algorithm: "fixed-window";
  windowMs: number;
  maxRequests: number;
}

interface RedisTokenBucketOptions extends BaseRedisRateLimiterOptions {
  algorithm: "token-bucket";
  capacity: number;
  refillIntervalMs: number;
  now?: () => number;
}

type RedisRateLimiterOptions = RedisFixedWindowOptions | RedisTokenBucketOptions;

// Redis executes each read-check-update sequence atomically.
export const FIXED_WINDOW_SCRIPT = `
local count = redis.call("GET", KEYS[1])

if not count then
  redis.call("SET", KEYS[1], 1, "PX", ARGV[1])
  return {1, 0}
end

local ttl = redis.call("PTTL", KEYS[1])
if ttl < 0 then
  ttl = tonumber(ARGV[1])
  redis.call("PEXPIRE", KEYS[1], ttl)
end

if tonumber(count) >= tonumber(ARGV[2]) then
  return {0, ttl}
end

redis.call("INCR", KEYS[1])
return {1, 0}
`;

export const TOKEN_BUCKET_SCRIPT = `
local capacity = tonumber(ARGV[1])
local refill_interval = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local bucket = redis.call("HMGET", KEYS[1], "tokens", "updated_at")
local tokens = tonumber(bucket[1])
local updated_at = tonumber(bucket[2])

if not tokens or not updated_at then
  tokens = capacity
  updated_at = now
end

local elapsed = math.max(0, now - updated_at)
tokens = math.min(capacity, tokens + elapsed / refill_interval)
updated_at = math.max(now, updated_at)

local allowed = 0
local retry_after = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry_after = math.ceil(updated_at - now + (1 - tokens) * refill_interval)
end

redis.call("HSET", KEYS[1], "tokens", tokens, "updated_at", updated_at)
local time_to_full = math.max(1, math.ceil((capacity - tokens) * refill_interval))
redis.call("PEXPIRE", KEYS[1], time_to_full)
return {allowed, retry_after}
`;

function validatePositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive safe integer`);
  }
}

function parseDecision(reply: unknown): RateLimitDecision {
  if (!Array.isArray(reply) || reply.length !== 2) {
    throw new Error("Redis returned an invalid rate-limit decision");
  }

  const allowed = Number(reply[0]);
  const retryAfterMs = Number(reply[1]);
  if ((allowed !== 0 && allowed !== 1) || !Number.isSafeInteger(retryAfterMs) || retryAfterMs < 0) {
    throw new Error("Redis returned an invalid rate-limit decision");
  }

  return allowed === 1 ? { allowed: true } : { allowed: false, retryAfterMs };
}

export function createRedisRateLimiter(
  client: RedisEvalClient,
  options: RedisRateLimiterOptions,
): AsyncRateLimiter {
  if (options.algorithm === "fixed-window") {
    validatePositiveInteger(options.windowMs, "windowMs");
    validatePositiveInteger(options.maxRequests, "maxRequests");
  } else {
    validatePositiveInteger(options.capacity, "capacity");
    validatePositiveInteger(options.refillIntervalMs, "refillIntervalMs");
  }

  const keyPrefix = options.keyPrefix ?? "gateway:rate-limit";

  return {
    async consume(identity) {
      const encodedIdentity = Buffer.from(identity).toString("base64url");
      const redisKey = `${keyPrefix}:${options.algorithm}:${encodedIdentity}`;

      const reply = options.algorithm === "fixed-window"
        ? await client.eval(FIXED_WINDOW_SCRIPT, {
            keys: [redisKey],
            arguments: [String(options.windowMs), String(options.maxRequests)],
          })
        : await client.eval(TOKEN_BUCKET_SCRIPT, {
            keys: [redisKey],
            arguments: [
              String(options.capacity),
              String(options.refillIntervalMs),
              String((options.now ?? Date.now)()),
            ],
          });

      return parseDecision(reply);
    },
  };
}
