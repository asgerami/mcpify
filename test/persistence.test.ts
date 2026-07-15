import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { SqliteServerStore } from "../src/controlplane/store.js";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { Vault } from "../src/controlplane/vault.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

test("ServerStore upserts, lists, and deletes records", async () => {
  const store = SqliteServerStore.open(":memory:");
  await store.upsert({ id: "a", name: "A", slug: "a", specSource: "s1", baseUrl: "u1", createdAt: 1 });
  await store.upsert({ id: "b", name: "B", slug: "b", specSource: "s2", baseUrl: "u2", createdAt: 2 });

  let all = await store.all();
  assert.deepEqual(all.map((r) => r.id), ["a", "b"]); // oldest first

  // Upsert on the same id updates in place rather than duplicating.
  await store.upsert({ id: "a", name: "A2", slug: "a", specSource: "s1b", baseUrl: "u1", createdAt: 1 });
  all = await store.all();
  assert.equal(all.length, 2);
  assert.equal(all.find((r) => r.id === "a")?.name, "A2");

  await store.delete("a");
  assert.deepEqual((await store.all()).map((r) => r.id), ["b"]);
  await store.close();
});

test("a server created with a store survives a fresh registry (rehydrate)", async () => {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-persist-"));
  const dbPath = join(dir, "cp.db");

  // First registry: create a server, then close the store.
  const store1 = SqliteServerStore.open(dbPath);
  const reg1 = new ServerRegistry({ serverStore: store1 });
  const created = await reg1.create({ spec: SPEC, name: "Persisted API" });
  assert.equal(created.slug, "persisted-api");
  await store1.close();

  // Second registry on the same file: load() re-ingests the stored spec.
  const store2 = SqliteServerStore.open(dbPath);
  const reg2 = new ServerRegistry({ serverStore: store2 });
  const result = await reg2.load();
  assert.equal(result.restored, 1);
  assert.equal(result.failed.length, 0);

  const list = reg2.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].slug, "persisted-api");
  assert.equal(list[0].toolCount, 4);
  // createdAt is preserved across the restart.
  assert.equal(list[0].createdAt, created.createdAt);
  await store2.close();
});

test("credentials persist encrypted and are restored on rehydrate", async () => {
  const store1 = SqliteServerStore.open(":memory:");
  const key = randomBytes(32);
  const reg1 = new ServerRegistry({ serverStore: store1, vault: new Vault(key) });
  const entry = await reg1.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });
  await reg1.setCredential(entry.id, "apiKeyAuth", "key-123");

  // On disk, the value is an encrypted envelope, not the plaintext.
  const stored = await store1.credentialsFor(entry.id);
  assert.match(stored.bearerAuth, /^v1:/);
  assert.ok(!JSON.stringify(stored).includes("sk-secret"));

  // A fresh registry with the same key + store decrypts them back.
  const reg2 = new ServerRegistry({ serverStore: store1, vault: new Vault(key) });
  const result = await reg2.load();
  assert.equal(result.restored, 1);
  assert.equal(reg2.get(entry.id)?.creds.bearerAuth, "sk-secret");
  assert.equal(reg2.get(entry.id)?.creds.apiKeyAuth, "key-123");
  await store1.close();
});

test("a wrong key skips the credential but still loads the server", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg1 = new ServerRegistry({ serverStore: store, vault: new Vault(randomBytes(32)) });
  const entry = await reg1.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });

  const reg2 = new ServerRegistry({ serverStore: store, vault: new Vault(randomBytes(32)) });
  const result = await reg2.load();
  assert.equal(result.restored, 1); // server still loads
  assert.equal(reg2.get(entry.id)?.creds.bearerAuth, undefined); // bad cred skipped
  await store.close();
});

test("without a vault, credentials are not persisted", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg = new ServerRegistry({ serverStore: store }); // no vault
  const entry = await reg.create({ spec: SPEC, auth: { bearerAuth: "sk-secret" } });
  assert.deepEqual(await store.credentialsFor(entry.id), {});
  await store.close();
});

test("removing a server deletes its persisted record", async () => {
  const store = SqliteServerStore.open(":memory:");
  const reg = new ServerRegistry({ serverStore: store });
  const entry = await reg.create({ spec: SPEC });
  assert.equal((await store.all()).length, 1);

  await reg.remove(entry.id);
  assert.equal((await store.all()).length, 0);
  await store.close();
});

test("load reports specs it can't re-ingest without dropping them", async () => {
  const store = SqliteServerStore.open(":memory:");
  await store.upsert({
    id: "broken",
    name: "Broken",
    slug: "broken",
    specSource: "/nonexistent/spec.yaml",
    baseUrl: "https://x",
    createdAt: 1,
  });
  const reg = new ServerRegistry({ serverStore: store });
  const result = await reg.load();
  assert.equal(result.restored, 0);
  assert.equal(result.failed.length, 1);
  assert.equal(result.failed[0].id, "broken");
  // The record is kept for a future boot, not silently dropped.
  assert.equal((await store.all()).length, 1);
  await store.close();
});
