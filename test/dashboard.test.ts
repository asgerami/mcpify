import { test } from "node:test";
import assert from "node:assert/strict";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";

test("GET / serves the dashboard HTML page", async () => {
  const app = buildControlPlane(new ServerRegistry());
  try {
    const res = await app.inject({ url: "/" });
    assert.equal(res.statusCode, 200);
    assert.match(res.headers["content-type"] ?? "", /text\/html/);
    assert.match(res.body, /Wrangl · Control Plane/);
    // It's self-contained (no external scripts/styles — CSP-safe).
    assert.doesNotMatch(res.body, /<script[^>]+src=/);
    assert.doesNotMatch(res.body, /<link[^>]+stylesheet/);
    // And it actually drives the API.
    assert.match(res.body, /\/servers/);
  } finally {
    await app.close();
  }
});

test("dashboard route does not shadow the REST API", async () => {
  const app = buildControlPlane(new ServerRegistry());
  try {
    const health = await app.inject({ url: "/health" });
    assert.equal(health.json().status, "ok");
    const servers = await app.inject({ url: "/servers" });
    assert.deepEqual(servers.json(), []);
  } finally {
    await app.close();
  }
});
