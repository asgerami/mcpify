import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/parser/openapi.js";
import { watchSpec } from "../src/runtime/watch.js";
import type { GeneratedServer } from "../src/types.js";

function spec(paths: string[]): string {
  const obj = {
    openapi: "3.0.0",
    info: { title: "watched", version: "1" },
    servers: [{ url: "http://example.test" }],
    paths: Object.fromEntries(
      paths.map((p) => [p, { get: { operationId: p.replace(/\W/g, "_"), responses: {} } }]),
    ),
  };
  return JSON.stringify(obj);
}

test("watchSpec fires onChange when the spec gains a path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-watch-"));
  const file = join(dir, "api.json");
  await writeFile(file, spec(["/a"]));

  const seed = await ingest(file);
  assert.equal(seed.tools.length, 1);

  let received: GeneratedServer | undefined;
  const handle = watchSpec(
    file,
    { intervalMs: 50, seed },
    (next) => {
      received = next;
    },
  );

  try {
    // Mutate the spec; the next poll should detect it and fire once.
    await writeFile(file, spec(["/a", "/b"]));
    await waitFor(() => received !== undefined, 2000);
    assert.equal(received?.tools.length, 2);
  } finally {
    handle.stop();
  }
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
}
