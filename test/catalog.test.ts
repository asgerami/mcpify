import { test } from "node:test";
import assert from "node:assert/strict";
import { loadCatalog, findCatalogEntry } from "../src/controlplane/seed.js";

test("the bundled catalog lists ready-made servers with ids", () => {
  const entries = loadCatalog();
  assert.ok(entries.length >= 4);
  // Every entry an operator would `add` needs an id, name, and spec.
  for (const e of entries) {
    assert.ok(e.id, `catalog entry "${e.name}" is missing an id`);
    assert.ok(e.name && e.spec);
  }
  const ids = entries.map((e) => e.id);
  assert.ok(ids.includes("petstore"));
  assert.ok(ids.includes("github"));
});

test("findCatalogEntry resolves by id and by name, case-insensitively", () => {
  const byId = findCatalogEntry("github");
  assert.equal(byId?.name, "GitHub");
  assert.ok(/^https?:\/\//.test(byId!.spec));

  const byName = findCatalogEntry("swagger petstore");
  assert.equal(byName?.id, "petstore");

  const upper = findCatalogEntry("STRIPE");
  assert.equal(upper?.id, "stripe");
});

test("a bundled local spec resolves to an absolute path", () => {
  const local = findCatalogEntry("jsonplaceholder");
  assert.ok(local);
  assert.ok(local!.spec.endsWith(".yaml"));
  assert.ok(local!.spec.startsWith("/"), "local spec should be an absolute path");
});

test("an unknown id returns undefined", () => {
  assert.equal(findCatalogEntry("does-not-exist"), undefined);
});
