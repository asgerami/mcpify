import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/parser/openapi.js";

/** A spec whose `servers` URL is relative (like Swagger Petstore's "/api/v3"). */
const RELATIVE_SPEC = {
  openapi: "3.0.0",
  info: { title: "Rel", version: "1" },
  servers: [{ url: "/api/v3" }],
  paths: { "/ping": { get: { operationId: "ping", responses: {} } } },
};

test("a relative server URL is resolved against the spec's URL", async () => {
  const server: Server = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(RELATIVE_SPEC));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const gen = await ingest(`http://127.0.0.1:${port}/openapi.json`);
    // "/api/v3" resolved against the spec origin, not left relative.
    assert.equal(gen.baseUrl, `http://127.0.0.1:${port}/api/v3`);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("a relative server URL from a file needs an explicit base URL", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-rel-"));
  const file = join(dir, "spec.json");
  await writeFile(file, JSON.stringify(RELATIVE_SPEC));

  // No base URL → can't know the host → clear error.
  await assert.rejects(ingest(file), /relative/i);
  // With --base-url it resolves.
  const gen = await ingest(file, { baseUrl: "https://api.example.com" });
  assert.equal(gen.baseUrl, "https://api.example.com");
});
