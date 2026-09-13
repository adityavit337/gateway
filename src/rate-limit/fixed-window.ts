import type { RateLimiter } from "./types.js";

interface FixedWindowOptions {
  windowMs: number;
  maxRequests: number;
  // Tests supply a clock they can advance without actually waiting.
  now?: () => number;
}

export function createFixedWindowLimiter({
  windowMs,
  maxRequests,
  now = Date.now,
}: FixedWindowOptions): RateLimiter {
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError("windowMs must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxRequests) || maxRequests <= 0) {
    throw new RangeError("maxRequests must be a positive safe integer");
  }

  const clients = new Map<string, { windowStart: number; requestCount: number }>();

  return {
    consume(key) {
      const timestamp = now();
      let client = clients.get(key);

      if (!client || timestamp - client.windowStart >= windowMs) {
        client = { windowStart: timestamp, requestCount: 0 };
        clients.set(key, client);
      }

      if (client.requestCount >= maxRequests) {
        return {
          allowed: false,
          retryAfterMs: client.windowStart + windowMs - timestamp,
        };
      }

      client.requestCount += 1;
      return { allowed: true };
    },

    // Scheduling belongs to the caller, so the algorithm creates no timers.
    cleanup() {
      const timestamp = now();
      let removed = 0;
      for (const [key, client] of clients) {
        if (timestamp - client.windowStart >= windowMs) {
          clients.delete(key);
          removed += 1;
        }
      }
      return removed;
    },
  };
}
