// Algorithms make decisions; the gateway translates them into HTTP responses.
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export interface RateLimiter {
  consume(key: string): RateLimitDecision;
  // Return the number of expired entries removed.
  cleanup(): number;
}
