import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { executeTool } from "../src/runtime/proxy.js";
import type { ProxyContext } from "../src/runtime/proxy.js";
import type { ToolDef } from "../src/types.js";

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "t",
    description: "",
    method: "GET",
    pathTemplate: "/",
    params: [],
    body: undefined,
    security: [],
    ...overrides,
  };
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return (server.address() as AddressInfo).port;
}

test("a GET retries a transient 503 and succeeds", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    if (hits < 3) res.writeHead(503).end("try again");
    else res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = {
      baseUrl: `http://127.0.0.1:${port}`,
      schemes: {},
      creds: {},
      maxRetries: 2,
    };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 200);
    assert.equal(hits, 3, "expected two retries before success");
  } finally {
    server.close();
  }
});

test("a POST does not retry a 503 — it might have already run server-side", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(503).end("try again");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool({ method: "POST" }), {}, ctx);
    assert.equal(result.statusCode, 503);
    assert.equal(hits, 1, "POST must not be retried automatically");
  } finally {
    server.close();
  }
});

test("retries are exhausted and the last response is returned as-is", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(502).end("bad gateway");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 502);
    assert.equal(hits, 3, "1 initial attempt + 2 retries");
  } finally {
    server.close();
  }
});

test("maxRetries: 0 disables retrying entirely", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(503).end("try again");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 0 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 503);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});

test("a network error is retried and eventually throws a clear error", async () => {
  // Nothing listens on this port.
  const ctx: ProxyContext = { baseUrl: "http://127.0.0.1:1", schemes: {}, creds: {}, maxRetries: 1 };
  await assert.rejects(
    () => executeTool(tool(), {}, ctx),
    /Upstream request failed/,
  );
});

test("a 4xx response is never retried", async () => {
  let hits = 0;
  const server = createServer((_req, res) => {
    hits++;
    res.writeHead(404).end("not found");
  });
  const port = await listen(server);

  try {
    const ctx: ProxyContext = { baseUrl: `http://127.0.0.1:${port}`, schemes: {}, creds: {}, maxRetries: 2 };
    const result = await executeTool(tool(), {}, ctx);
    assert.equal(result.statusCode, 404);
    assert.equal(hits, 1);
  } finally {
    server.close();
  }
});
