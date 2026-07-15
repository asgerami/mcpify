import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { randomBytes } from "node:crypto";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { SqliteServerStore } from "../src/controlplane/store.js";
import { Vault } from "../src/controlplane/vault.js";
import { OAuthManager } from "../src/controlplane/oauth-manager.js";
import { buildControlPlane } from "../src/controlplane/api.js";
import { executeTool, type ProxyContext } from "../src/runtime/proxy.js";
import type { ToolDef } from "../src/types.js";

/** A spec with one oauth2 scheme and one secured operation. */
async function oauthSpec(tokenUrl: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wrangl-oauth-"));
  const file = join(dir, "spec.json");
  await writeFile(
    file,
    JSON.stringify({
      openapi: "3.0.0",
      info: { title: "OAuth API", version: "1" },
      servers: [{ url: "http://example.test" }],
      components: {
        securitySchemes: {
          userAuth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://provider.test/authorize",
                tokenUrl,
                scopes: { read: "Read access" },
              },
            },
          },
        },
      },
      security: [{ userAuth: [] }],
      paths: { "/me": { get: { operationId: "getMe", responses: {} } } },
    }),
  );
  return file;
}

/** Mock token endpoint returning a rotating access token. */
async function tokenServer(): Promise<{ url: string; issued: string[]; close: () => Promise<void> }> {
  const issued: string[] = [];
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      const token = "at-" + (issued.length + 1);
      issued.push(token);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ access_token: token, refresh_token: "rt-1", expires_in: 3600 }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/token`,
    issued,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("OAuth flow: configure → authorize → callback injects a token; refresh + restore", async () => {
  const token = await tokenServer();
  const store = SqliteServerStore.open(":memory:");
  const vault = new Vault(randomBytes(32));
  const registry = new ServerRegistry({ serverStore: store, vault });
  const entry = await registry.create({ spec: await oauthSpec(token.url), name: "OA" });

  const manager = new OAuthManager({
    registry, store, vault,
    callbackUrl: "http://127.0.0.1:4000/oauth/callback",
  });

  try {
    // Configure just the client id (URLs/scopes default from the spec).
    await manager.configure(entry.id, "userAuth", { clientId: "cid", clientSecret: "sec" });
    assert.equal((await manager.status(entry.id, "userAuth")).configured, true);
    assert.equal((await manager.status(entry.id, "userAuth")).connected, false);

    // Begin authorization and capture the CSRF state from the URL.
    const authorizeUrl = new URL(await manager.startAuthorization(entry.id, "userAuth"));
    assert.equal(authorizeUrl.origin + authorizeUrl.pathname, "https://provider.test/authorize");
    const state = authorizeUrl.searchParams.get("state")!;
    assert.ok(state);

    // Simulate the provider redirect back to our callback.
    const result = await manager.handleCallback(state, "auth-code");
    assert.deepEqual(result, { serverId: entry.id, scheme: "userAuth" });

    // The access token is now injected into the live credential store.
    assert.equal(entry.creds.userAuth, "at-1");
    assert.equal((await manager.status(entry.id, "userAuth")).connected, true);

    // Refresh rotates the access token.
    assert.equal(await manager.refresh(entry.id, "userAuth"), true);
    assert.equal(entry.creds.userAuth, "at-2");

    // A fresh registry (restart) re-injects the stored token via restoreAll.
    const registry2 = new ServerRegistry({ serverStore: store, vault });
    await registry2.create({ spec: await oauthSpec(token.url), name: "OA" });
    const manager2 = new OAuthManager({
      registry: registry2, store, vault, callbackUrl: "http://127.0.0.1:4000/oauth/callback",
    });
    await manager2.restoreAll();
    assert.ok(registry2.get(entry.id)!.creds.userAuth?.startsWith("at-"));
  } finally {
    await token.close();
  }
});

test("control-plane OAuth endpoints: config → authorize redirect → callback", async () => {
  const token = await tokenServer();
  const store = SqliteServerStore.open(":memory:");
  const vault = new Vault(randomBytes(32));
  const registry = new ServerRegistry({ serverStore: store, vault });
  const entry = await registry.create({ spec: await oauthSpec(token.url), name: "OA" });
  const manager = new OAuthManager({ registry, store, vault, callbackUrl: "http://127.0.0.1/oauth/callback" });
  const app = buildControlPlane(registry, { oauth: manager });

  try {
    const cfg = await app.inject({
      method: "POST", url: `/servers/${entry.id}/oauth/userAuth/config`,
      payload: { clientId: "cid", clientSecret: "sec" },
    });
    assert.equal(cfg.statusCode, 204);

    const authz = await app.inject({ url: `/servers/${entry.id}/oauth/userAuth/authorize` });
    assert.equal(authz.statusCode, 200);
    const state = new URL(authz.json().url).searchParams.get("state")!;
    assert.ok(state);

    const cb = await app.inject({ url: `/oauth/callback?state=${state}&code=abc` });
    assert.equal(cb.statusCode, 200);
    assert.match(cb.body, /Connected/);

    const status = (await app.inject({ url: `/servers/${entry.id}/oauth` })).json();
    assert.equal(status[0].scheme, "userAuth");
    assert.equal(status[0].connected, true);
  } finally {
    await app.close();
    await token.close();
  }
});

test("OAuth endpoints are 501 when no vault/manager is configured", async () => {
  const registry = new ServerRegistry();
  const app = buildControlPlane(registry); // no oauth manager
  await registry.create({ spec: await oauthSpec("http://x/token"), name: "OA" });
  try {
    const res = await app.inject({
      method: "POST", url: "/servers/oa/oauth/userAuth/config", payload: { clientId: "c" },
    });
    assert.equal(res.statusCode, 501);
  } finally {
    await app.close();
  }
});

test("an unknown callback state is rejected", async () => {
  const store = SqliteServerStore.open(":memory:");
  const vault = new Vault(randomBytes(32));
  const registry = new ServerRegistry({ serverStore: store, vault });
  const manager = new OAuthManager({ registry, store, vault, callbackUrl: "http://x/cb" });
  await assert.rejects(manager.handleCallback("bogus-state", "code"), /expired/i);
});

test("proxy refreshes the token and retries once on a 401", async () => {
  // Upstream accepts only "Bearer good"; first request has a stale token.
  const server: Server = createServer((req, res) => {
    if (req.headers.authorization === "Bearer good") {
      res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
    } else {
      res.writeHead(401).end("unauthorized");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;

  const tool: ToolDef = {
    name: "get_me", description: "", method: "GET", pathTemplate: "/me",
    params: [], body: undefined, security: ["userAuth"],
  };
  let refreshed = false;
  const ctx: ProxyContext = {
    baseUrl: `http://127.0.0.1:${port}`,
    schemes: { userAuth: { type: "oauth2", name: "userAuth", scopes: [] } },
    creds: { userAuth: "stale" },
    onUnauthorized: async (schemes) => {
      assert.deepEqual(schemes, ["userAuth"]);
      ctx.creds.userAuth = "good"; // simulate a successful refresh
      refreshed = true;
      return true;
    },
  };

  try {
    const result = await executeTool(tool, {}, ctx);
    assert.equal(refreshed, true);
    assert.equal(result.statusCode, 200);
    assert.equal(result.ok, true);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
