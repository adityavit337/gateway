// The gateway is a reverse proxy: clients talk to IT, and it forwards their
// requests to the backend, applying rate limiting before forwarding.
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createFixedWindowLimiter } from "../rate-limit/fixed-window.js";
import { createTokenBucketLimiter } from "../rate-limit/token-bucket.js";
import type { RateLimiter } from "../rate-limit/types.js";

const GATEWAY_PORT = 8080;
const BACKEND_HOST = "localhost";
const BACKENDS: Backend[] = [
  { port: 9000, healthy: true },
  { port: 9001, healthy: true },
];
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const FORWARDED_REQUEST_TIMEOUT_MS = 2_000;
const CLEANUP_INTERVAL_MS = 10_000;
let nextBackendIndex = 0;

// ---------------------------------------------------------------------------
// Two tiny types that define our whole architecture:
//
//   Handler    = a function that fully deals with one request
//   Middleware = a function that WRAPS a handler and returns a new handler
//                which does something extra before/after (or instead of!)
//                calling the one it wrapped
// ---------------------------------------------------------------------------
type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type Middleware = (next: Handler) => Handler;
type RateLimitAlgorithm = "fixed-window" | "token-bucket";
interface Backend {
  port: number;
  healthy: boolean;
}

function getRateLimitAlgorithm(): RateLimitAlgorithm {
  const algorithm = process.env.RATE_LIMIT_ALGORITHM ?? "fixed-window";
  if (algorithm !== "fixed-window" && algorithm !== "token-bucket") {
    throw new Error(
      'RATE_LIMIT_ALGORITHM must be either "fixed-window" or "token-bucket"',
    );
  }
  return algorithm;
}

function createRateLimiter(algorithm: RateLimitAlgorithm): RateLimiter {
  if (algorithm === "fixed-window") {
    return createFixedWindowLimiter({ windowMs: 10_000, maxRequests: 5 });
  }

  return createTokenBucketLimiter({ capacity: 5, refillIntervalMs: 2_000 });
}

const rateLimitAlgorithm = getRateLimitAlgorithm();

function getNextBackend(): Backend | undefined {
  const healthyBackends = BACKENDS.filter((backend) => backend.healthy);
  if (healthyBackends.length === 0) {
    return undefined;
  }

  const backend = healthyBackends[nextBackendIndex % healthyBackends.length]!;
  nextBackendIndex = (nextBackendIndex + 1) % healthyBackends.length;
  return backend;
}

function setBackendHealth(backend: Backend, healthy: boolean): void {
  if (backend.healthy !== healthy) {
    backend.healthy = healthy;
    console.log(`backend ${backend.port} is now ${healthy ? "healthy" : "unhealthy"}`);
  }
}

function checkBackend(backend: Backend): void {
  const request = http.get(
    {
      host: BACKEND_HOST,
      port: backend.port,
      path: "/health",
      timeout: HEALTH_CHECK_TIMEOUT_MS,
    },
    (response) => {
      response.resume();
      const status = response.statusCode ?? 500;
      setBackendHealth(backend, status >= 200 && status < 300);
    },
  );

  request.on("timeout", () => request.destroy());
  request.on("error", () => setBackendHealth(backend, false));
}

function checkAllBackends(): void {
  for (const backend of BACKENDS) {
    checkBackend(backend);
  }
}

// ---------------------------------------------------------------------------
// The proxy handler: forwards the incoming request to the backend and
// streams the backend's response back to the client.
// ---------------------------------------------------------------------------
const proxyHandler: Handler = (req, res) => {
  // Round robin gives each healthy backend one request in turn.
  const backend = getNextBackend();
  if (!backend) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no healthy backends" }));
    return;
  }

  // Open a request TO the backend that mirrors the one we received:
  // same method, same path, same headers.
  let timedOut = false;
  const upstream = http.request(
    {
      host: BACKEND_HOST,
      port: backend.port,
      path: req.url,
      method: req.method,
      headers: req.headers,
      timeout: FORWARDED_REQUEST_TIMEOUT_MS,
    },
    // This callback fires when the backend starts responding. We copy its
    // status + headers to our client, then stream the body across.
    (backendRes) => {
      res.writeHead(backendRes.statusCode ?? 502, backendRes.headers);
      backendRes.pipe(res); // stream: backend -> client, chunk by chunk
    },
  );

  // A reachable backend can still be too slow. Sending 504 here distinguishes
  // that case from connection failures (502) and no healthy backends (503).
  upstream.on("timeout", () => {
    timedOut = true;
    if (!res.headersSent) {
      res.writeHead(504, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "gateway timeout" }));
    } else {
      res.destroy();
    }
    upstream.destroy(new Error("forwarded request timed out"));
  });

  // If the backend is down/unreachable, don't leave the client hanging —
  // answer 502 Bad Gateway, the standard "proxy couldn't reach upstream" code.
  upstream.on("error", (err) => {
    if (timedOut) {
      return;
    }
    setBackendHealth(backend, false);
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "bad gateway", detail: err.message }));
    } else {
      res.destroy();
    }
  });

  // Stream the client's request BODY to the backend (matters for POST/PUT).
  // For a GET this simply ends the upstream request.
  req.pipe(upstream);
};

// ---------------------------------------------------------------------------
// Logging middleware: wraps any handler, logs every request that passes
// through. This wrapping pattern is THE core idea of the project — the rate
// limiter below is another middleware exactly like this one, except
// it will sometimes send a 429 INSTEAD of calling next().
// ---------------------------------------------------------------------------
const loggingMiddleware: Middleware = (next) => (req, res) => {
  const start = Date.now();
  // "finish" fires when the response has fully been sent — so we can log
  // the status code and how long the request took.
  res.on("finish", () => {
    console.log(
      `${req.method} ${req.url} from ${req.socket.remoteAddress} -> ${res.statusCode} (${Date.now() - start}ms)`,
    );
  });
  next(req, res); // pass the request along to the wrapped handler
};

// ---------------------------------------------------------------------------
// The selected algorithm owns the counters or buckets. This middleware only
// translates its allow/reject decision into an HTTP response.
// ---------------------------------------------------------------------------
const rateLimitMiddleware: Middleware = (next) => {
  const limiter = createRateLimiter(rateLimitAlgorithm);

  // Prevent inactive clients from staying in memory forever.
  const cleanup = setInterval(() => {
    limiter.cleanup();
  }, CLEANUP_INTERVAL_MS);
  cleanup.unref(); // This timer alone should not keep the process running.

  return (req, res) => {
    // Use the connected peer's IP, not a client-supplied forwarded header.
    const ip = req.socket.remoteAddress ?? "unknown";
    const decision = limiter.consume(ip);

    if (!decision.allowed) {
      const retryAfterSeconds = Math.ceil(decision.retryAfterMs / 1000);
      res.writeHead(429, {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      });
      res.end(JSON.stringify({ error: "too many requests" }));
      return; // Stop here: rejected requests never reach the backend.
    }

    next(req, res);
  };
};

// Logging wraps the limiter so it records rejected requests too.
const handler = loggingMiddleware(rateLimitMiddleware(proxyHandler));

checkAllBackends();
const healthChecks = setInterval(checkAllBackends, HEALTH_CHECK_INTERVAL_MS);
healthChecks.unref();

http.createServer(handler).listen(GATEWAY_PORT, () => {
  console.log(
    `gateway listening on http://localhost:${GATEWAY_PORT} -> backends ${BACKENDS.map((backend) => backend.port).join(", ")} (${rateLimitAlgorithm})`,
  );
});
