import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { createClient } from "redis";
import { createRedisRateLimiter } from "../rate-limit/redis.js";
import type { RateLimitAlgorithm } from "../rate-limit/types.js";

const DEFAULT_GATEWAY_PORT = 8080;
const BACKEND_HOST = "localhost";
const BACKENDS: Backend[] = [
  { port: 9000, healthy: true },
  { port: 9001, healthy: true },
];
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const HEALTH_CHECK_TIMEOUT_MS = 1_000;
const FORWARDED_REQUEST_TIMEOUT_MS = 2_000;
const CLEANUP_INTERVAL_MS = 10_000;
const CACHE_TTL_MS = 5_000;
const REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6379";
let nextBackendIndex = 0;

function getGatewayPort(): number {
  const configuredPort = process.env.GATEWAY_PORT;
  if (configuredPort === undefined) return DEFAULT_GATEWAY_PORT;

  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("GATEWAY_PORT must be an integer between 1 and 65535");
  }
  return port;
}

const gatewayPort = getGatewayPort();

interface CachedResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
  expiresAt: number;
}

const responseCache = new Map<string, CachedResponse>();
const cacheCleanup = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of responseCache) {
    if (entry.expiresAt <= now) responseCache.delete(key);
  }
}, CLEANUP_INTERVAL_MS);
cacheCleanup.unref();

function getCacheKey(req: IncomingMessage): string | undefined {
  if (
    req.method !== "GET" ||
    Object.keys(req.headers).some((name) =>
      ["authorization", "cookie", "range", "cache-control", "pragma",
        "content-length", "transfer-encoding"].includes(name) || name.startsWith("if-"),
    )
  ) return undefined;

  const headers = Object.entries(req.headers).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([req.method, req.url, headers]);
}

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
type Middleware = (next: Handler) => Handler;
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

const rateLimitAlgorithm = getRateLimitAlgorithm();
const redisClient = createClient({
  url: REDIS_URL,
  disableOfflineQueue: true,
});
redisClient.on("error", (error) => console.error(`Redis connection error: ${error.message}`));

const rateLimiter = rateLimitAlgorithm === "fixed-window"
  ? createRedisRateLimiter(redisClient, {
      algorithm: "fixed-window",
      windowMs: 10_000,
      maxRequests: 5,
    })
  : createRedisRateLimiter(redisClient, {
      algorithm: "token-bucket",
      capacity: 5,
      refillIntervalMs: 2_000,
    });

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

const proxyHandler: Handler = (req, res) => {
  const cacheKey = getCacheKey(req);
  const cached = cacheKey === undefined ? undefined : responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.resume();
    res.writeHead(cached.status, { ...cached.headers, "x-cache": "HIT" });
    res.end(cached.body);
    return;
  }
  if (cached && cacheKey !== undefined) responseCache.delete(cacheKey);
  res.setHeader("x-cache", cacheKey === undefined ? "BYPASS" : cached ? "EXPIRED" : "MISS");

  // Round robin gives each healthy backend one request in turn.
  const backend = getNextBackend();
  if (!backend) {
    res.writeHead(503, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "no healthy backends" }));
    return;
  }

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
    (backendRes) => {
      const status = backendRes.statusCode ?? 502;
      const headers = { ...backendRes.headers };
      // The gateway owns this diagnostic header, even if a backend sends one.
      delete headers["x-cache"];
      const canStore = cacheKey !== undefined && status >= 200 && status < 300 &&
        status !== 206 && headers["set-cookie"] === undefined &&
        headers["cache-control"] === undefined && headers.vary !== "*";

      // An interrupted body must never become a cached successful response.
      backendRes.on("error", (err) => upstream.destroy(err));
      if (!canStore) {
        res.setHeader("x-cache", "BYPASS");
        res.writeHead(status, headers);
        backendRes.pipe(res);
        return;
      }

      const chunks: Buffer[] = [];
      backendRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      backendRes.on("end", () => {
        if (!backendRes.complete || timedOut || res.destroyed || res.writableEnded) return;
        const body = Buffer.concat(chunks);
        // TTL starts only after we have received the entire response.
        responseCache.set(cacheKey, {
          status, headers, body, expiresAt: Date.now() + CACHE_TTL_MS,
        });
        res.writeHead(status, headers);
        res.end(body);
      });
    },
  );

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

  req.pipe(upstream);
};

const loggingMiddleware: Middleware = (next) => (req, res) => {
  const start = Date.now();
  res.on("finish", () => {
    console.log(
      `${req.method} ${req.url} from ${req.socket.remoteAddress} -> ${res.statusCode} (${Date.now() - start}ms)`,
    );
  });
  next(req, res); // pass the request along to the wrapped handler
};

const rateLimitMiddleware: Middleware = (next) => {
  return (req, res) => {
    // Use the connected peer's IP, not a client-supplied forwarded header.
    const ip = req.socket.remoteAddress ?? "unknown";
    void rateLimiter.consume(ip).then((decision) => {
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
    }).catch((error: unknown) => {
      const detail = error instanceof Error ? error.message : String(error);
      console.error(`rate-limit check failed: ${detail}`);
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(503, { "content-type": "application/json", "retry-after": "1" });
        res.end(JSON.stringify({ error: "rate limiter unavailable" }));
      }
    });
  };
};

// Logging wraps the limiter so it records rejected requests too.
const handler = loggingMiddleware(rateLimitMiddleware(proxyHandler));

await redisClient.connect();
console.log("connected to Redis for shared rate limiting");

checkAllBackends();
const healthChecks = setInterval(checkAllBackends, HEALTH_CHECK_INTERVAL_MS);
healthChecks.unref();

http.createServer(handler).listen(gatewayPort, () => {
  console.log(
    `gateway process ${process.pid} listening on http://localhost:${gatewayPort} -> backends ${BACKENDS.map((backend) => backend.port).join(", ")} (${rateLimitAlgorithm}, shared Redis state)`,
  );
});
