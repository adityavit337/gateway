import type { RateLimiter } from "./types.js";

interface TokenBucketOptions {
  capacity: number;
  // Time needed to earn one token. Each allowed request costs one token.
  refillIntervalMs: number;
  now?: () => number;
}

export function createTokenBucketLimiter({
  capacity,
  refillIntervalMs,
  now = Date.now,
}: TokenBucketOptions): RateLimiter {
  if (!Number.isSafeInteger(capacity) || capacity <= 0) {
    throw new RangeError("capacity must be a positive safe integer");
  }
  if (!Number.isSafeInteger(refillIntervalMs) || refillIntervalMs <= 0) {
    throw new RangeError("refillIntervalMs must be a positive safe integer");
  }

  const clients = new Map<string, { tokens: number; updatedAt: number }>();

  return {
    consume(key) {
      const timestamp = now();
      let client = clients.get(key);

      if (!client) {
        client = { tokens: capacity, updatedAt: timestamp };
        clients.set(key, client);
      }

      // Calculate earned tokens when needed; no refill timer is required.
      // Fractions are kept: 1 second earns 0.5 tokens with a 2-second interval.
      const elapsed = Math.max(0, timestamp - client.updatedAt);
      client.tokens = Math.min(capacity, client.tokens + elapsed / refillIntervalMs);
      client.updatedAt = Math.max(timestamp, client.updatedAt);

      if (client.tokens < 1) {
        return {
          allowed: false,
          retryAfterMs: Math.ceil(
            client.updatedAt - timestamp + (1 - client.tokens) * refillIntervalMs,
          ),
        };
      }

      client.tokens -= 1;
      return { allowed: true };
    },

    cleanup() {
      const timestamp = now();
      let removed = 0;
      for (const [key, client] of clients) {
        const elapsed = Math.max(0, timestamp - client.updatedAt);
        // Only forget buckets that would now be full. Recreating a partially
        // empty bucket would accidentally give the client extra tokens.
        if (client.tokens + elapsed / refillIntervalMs >= capacity) {
          clients.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
