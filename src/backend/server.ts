import http from "node:http";

// Set BACKEND_PORT before starting this file to run another backend instance.
const PORT = Number(process.env.BACKEND_PORT ?? 9000);
const SLOW_RESPONSE_DELAY_MS = 5_000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok", port: PORT }));
    return;
  }

  if (req.url === "/slow") {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ message: "slow response", port: PORT }));
    }, SLOW_RESPONSE_DELAY_MS);
    return;
  }

  const body = JSON.stringify({
    message: "hello from the backend",
    port: PORT,
    path: req.url,
    time: new Date().toISOString(),
  });

  res.writeHead(200, { "content-type": "application/json" });
  res.end(body);
});

server.listen(PORT, () => {
  console.log(`backend listening on http://localhost:${PORT}`);
});
