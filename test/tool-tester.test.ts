import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";

/**
 * A local upstream that both serves its own OpenAPI spec (at /openapi.json) and
 * answers the described endpoint (GET /items) — so the tool tester can be
 * exercised end to end without the public internet.
 */
async function upstream(): Promise<{ base: string; close: () => Promise<void> }> {
  let base = "";
  const server: Server = createServer((req, res) => {
    if (req.url === "/openapi.json") {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify({
          openapi: "3.0.0",
          info: { title: "Items API", version: "1" },
          servers: [{ url: base }],
          paths: {
            "/items": {
              get: {
                operationId: "listItems",
                parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }],
                responses: {},
              },
            },
          },
        }),
      );
    } else if (req.url?.startsWith("/items")) {
      res.writeHead(200, { "content-type": "application/json" }).end(
        JSON.stringify([{ id: 1, name: "widget" }, { id: 2, name: "gadget" }]),
      );
    } else res.writeHead(404).end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, close: () => new Promise((r) => server.close(() => r())) };
}

test("the tool tester invokes a tool and returns the upstream response", async () => {
  const up = await upstream();
  const app = buildControlPlane(new ServerRegistry());
  try {
    const created = await app.inject({
      method: "POST", url: "/servers", payload: { spec: `${up.base}/openapi.json`, name: "Items" },
    });
    const slug = created.json().slug;

    const res = await app.inject({
      method: "POST", url: `/servers/${slug}/tools/listitems/invoke`, payload: { limit: 2 },
    });
    assert.equal(res.statusCode, 200);
    const body = res.json();
    assert.equal(body.ok, true);
    assert.equal(body.statusCode, 200);
    const items = JSON.parse(body.body);
    assert.equal(items.length, 2);
    assert.equal(items[0].name, "widget");
  } finally {
    await app.close();
    await up.close();
  }
});

test("invoking an unknown tool is a 404", async () => {
  const up = await upstream();
  const app = buildControlPlane(new ServerRegistry());
  try {
    const created = await app.inject({
      method: "POST", url: "/servers", payload: { spec: `${up.base}/openapi.json` },
    });
    const slug = created.json().slug;
    const res = await app.inject({ method: "POST", url: `/servers/${slug}/tools/nope/invoke`, payload: {} });
    assert.equal(res.statusCode, 404);
  } finally {
    await app.close();
    await up.close();
  }
});
