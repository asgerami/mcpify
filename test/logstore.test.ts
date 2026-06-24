import { test } from "node:test";
import assert from "node:assert/strict";
import { LogStore } from "../src/runtime/logstore.js";
import type { RequestLog } from "../src/runtime/proxy.js";

function entry(over: Partial<RequestLog> = {}): RequestLog {
  return {
    tool: "get_post",
    method: "GET",
    url: "https://api.test/posts/1",
    statusCode: 200,
    latencyMs: 12,
    requestBody: '{"id":1}',
    responseBody: '{"id":1,"title":"x"}',
    ...over,
  };
}

test("records and queries logs newest-first", () => {
  const store = LogStore.open(":memory:");
  store.record("api", entry({ tool: "a" }));
  store.record("api", entry({ tool: "b" }));
  store.record("api", entry({ tool: "c" }));

  const rows = store.query();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => r.tool), ["c", "b", "a"]);
  assert.equal(rows[0].response_body, '{"id":1,"title":"x"}');
  store.close();
});

test("filters by server, tool, and status", () => {
  const store = LogStore.open(":memory:");
  store.record("alpha", entry({ tool: "x", statusCode: 200 }));
  store.record("beta", entry({ tool: "x", statusCode: 401 }));
  store.record("beta", entry({ tool: "y", statusCode: 200 }));

  assert.equal(store.query({ server: "beta" }).length, 2);
  assert.equal(store.query({ tool: "x" }).length, 2);
  assert.equal(store.query({ status: 401 }).length, 1);
  assert.equal(store.query({ server: "beta", tool: "y" })[0].tool, "y");
  store.close();
});

test("afterId returns ascending rows for tailing", () => {
  const store = LogStore.open(":memory:");
  store.record("api", entry({ tool: "a" }));
  const first = store.query({ limit: 1 })[0].id;
  store.record("api", entry({ tool: "b" }));
  store.record("api", entry({ tool: "c" }));

  const tail = store.query({ afterId: first });
  assert.deepEqual(tail.map((r) => r.tool), ["b", "c"]);
  store.close();
});

test("stores error rows with null status", () => {
  const store = LogStore.open(":memory:");
  store.record("api", { tool: "z", method: "POST", url: "u", latencyMs: 5, error: "boom" });
  const row = store.query()[0];
  assert.equal(row.status_code, null);
  assert.equal(row.error, "boom");
  store.close();
});
