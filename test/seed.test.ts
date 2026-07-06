import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { seedRegistry, loadManifest, defaultManifestPath } from "../src/controlplane/seed.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

test("the bundled manifest parses and lists anchors", () => {
  const entries = loadManifest(defaultManifestPath());
  assert.ok(entries.length >= 2);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("JSONPlaceholder"));
  assert.ok(entries.every((e) => e.name && e.spec));
});

/** Write a manifest into a temp dir with a local spec beside it. */
async function tempManifest(entries: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "mcpify-seed-"));
  await copyFile(SPEC, join(dir, "local.yaml"));
  const path = join(dir, "manifest.json");
  await writeFile(path, JSON.stringify({ servers: entries }));
  return path;
}

test("seedRegistry creates servers and is idempotent by name", async () => {
  const manifest = await tempManifest([{ name: "Local API", spec: "./local.yaml" }]);
  const registry = new ServerRegistry();

  const first = await seedRegistry(registry, manifest);
  assert.deepEqual(first.created, ["Local API"]);
  assert.equal(first.skipped.length, 0);
  assert.equal(registry.list().length, 1);

  // Second run: already present → skipped, no duplicate.
  const second = await seedRegistry(registry, manifest);
  assert.deepEqual(second.skipped, ["Local API"]);
  assert.equal(second.created.length, 0);
  assert.equal(registry.list().length, 1);
});

test("a bad spec is reported as failed without blocking the others", async () => {
  const manifest = await tempManifest([
    { name: "Good", spec: "./local.yaml" },
    { name: "Bad", spec: "./does-not-exist.yaml" },
  ]);
  const registry = new ServerRegistry();
  const result = await seedRegistry(registry, manifest);

  assert.deepEqual(result.created, ["Good"]);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].name, "Bad");
  assert.equal(registry.list().length, 1);
});
