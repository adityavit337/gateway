// Algorithms make decisions; the gateway translates them into HTTP responses.
export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; retryAfterMs: number };

export type RateLimitAlgorithm = "fixed-window" | "token-bucket";

export interface RateLimiter {
  consume(key: string): RateLimitDecision;
  // Return the number of expired entries removed.
  cleanup(): number;
}

export interface AsyncRateLimiter {
  consume(key: string): Promise<RateLimitDecision>;
}
