import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import {
  buildAuthorizeUrl,
  codeChallenge,
  generateCodeVerifier,
  generateState,
  exchangeCode,
  refreshTokens,
  isExpired,
  type OAuthConfig,
} from "../src/controlplane/oauth.js";

const CONFIG = (over: Partial<OAuthConfig> = {}): OAuthConfig => ({
  authorizationUrl: "https://provider.test/authorize",
  tokenUrl: "https://provider.test/token",
  clientId: "client-123",
  clientSecret: "secret-xyz",
  redirectUri: "http://127.0.0.1:4000/oauth/callback",
  scopes: ["read", "write"],
  ...over,
});

test("buildAuthorizeUrl includes all required params + PKCE", () => {
  const url = new URL(buildAuthorizeUrl(CONFIG(), { state: "st8", codeChallenge: "chal" }));
  assert.equal(url.origin + url.pathname, "https://provider.test/authorize");
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("client_id"), "client-123");
  assert.equal(p.get("redirect_uri"), "http://127.0.0.1:4000/oauth/callback");
  assert.equal(p.get("scope"), "read write");
  assert.equal(p.get("state"), "st8");
  assert.equal(p.get("code_challenge"), "chal");
  assert.equal(p.get("code_challenge_method"), "S256");
});

test("PKCE verifier/challenge are url-safe and deterministic", () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9_-]+$/);
  assert.equal(codeChallenge(v), codeChallenge(v));
  assert.notEqual(codeChallenge(v), codeChallenge(generateCodeVerifier()));
  assert.notEqual(generateState(), generateState());
});

test("isExpired handles missing token, no-expiry, and skew", () => {
  assert.equal(isExpired({ accessToken: "" }), true);
  assert.equal(isExpired({ accessToken: "t" }), false); // no expiresAt → not expired
  assert.equal(isExpired({ accessToken: "t", expiresAt: Date.now() + 5 * 60_000 }), false);
  assert.equal(isExpired({ accessToken: "t", expiresAt: Date.now() + 1000 }), true); // within skew
});

/** Mock token endpoint capturing the last form body it received. */
async function tokenServer(handler: (form: URLSearchParams) => object): Promise<{
  url: string;
  last: () => URLSearchParams;
  close: () => Promise<void>;
}> {
  let last = new URLSearchParams();
  const server: Server = createServer((req, res) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      last = new URLSearchParams(data);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(handler(last)));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/token`,
    last: () => last,
    close: () => new Promise((r) => server.close(() => r())),
  };
}

test("exchangeCode posts the code + PKCE verifier and parses tokens", async () => {
  const srv = await tokenServer(() => ({
    access_token: "at-1",
    refresh_token: "rt-1",
    expires_in: 3600,
    token_type: "Bearer",
  }));
  try {
    const tokens = await exchangeCode(CONFIG({ tokenUrl: srv.url }), {
      code: "the-code",
      codeVerifier: "verifier-1",
    });
    const form = srv.last();
    assert.equal(form.get("grant_type"), "authorization_code");
    assert.equal(form.get("code"), "the-code");
    assert.equal(form.get("code_verifier"), "verifier-1");
    assert.equal(form.get("client_secret"), "secret-xyz");
    assert.equal(tokens.accessToken, "at-1");
    assert.equal(tokens.refreshToken, "rt-1");
    assert.ok(tokens.expiresAt && tokens.expiresAt > Date.now());
  } finally {
    await srv.close();
  }
});

test("refreshTokens uses the refresh grant and keeps the old refresh token", async () => {
  const srv = await tokenServer(() => ({ access_token: "at-2", expires_in: 3600 }));
  try {
    const tokens = await refreshTokens(CONFIG({ tokenUrl: srv.url }), "rt-old");
    assert.equal(srv.last().get("grant_type"), "refresh_token");
    assert.equal(srv.last().get("refresh_token"), "rt-old");
    assert.equal(tokens.accessToken, "at-2");
    assert.equal(tokens.refreshToken, "rt-old"); // provider omitted → old kept
  } finally {
    await srv.close();
  }
});

test("clientCredentialsGrant posts the client_credentials grant", async () => {
  const { clientCredentialsGrant } = await import("../src/controlplane/oauth.js");
  const srv = await tokenServer(() => ({
    access_token: "m2m-1",
    expires_in: 3600,
    token_type: "Bearer",
  }));
  try {
    const tokens = await clientCredentialsGrant({
      tokenUrl: srv.url,
      clientId: "client-123",
      clientSecret: "secret-xyz",
      scopes: ["read"],
    });
    const form = srv.last();
    assert.equal(form.get("grant_type"), "client_credentials");
    assert.equal(form.get("client_id"), "client-123");
    assert.equal(form.get("client_secret"), "secret-xyz");
    assert.equal(form.get("scope"), "read");
    assert.equal(tokens.accessToken, "m2m-1");
  } finally {
    await srv.close();
  }
});

test("discoverOidc reads authorization and token endpoints", async () => {
  const { discoverOidc } = await import("../src/controlplane/oauth.js");
  const server: Server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        authorization_endpoint: "https://idp.test/authorize",
        token_endpoint: "https://idp.test/token",
      }),
    );
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    const discovered = await discoverOidc(`http://127.0.0.1:${port}/.well-known/openid-configuration`);
    assert.equal(discovered.authorizationUrl, "https://idp.test/authorize");
    assert.equal(discovered.tokenUrl, "https://idp.test/token");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test("exchangeCode throws on a token-endpoint error", async () => {
  const server: Server = createServer((_req, res) => {
    res.writeHead(400).end('{"error":"invalid_grant"}');
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as AddressInfo;
  try {
    await assert.rejects(
      exchangeCode(CONFIG({ tokenUrl: `http://127.0.0.1:${port}/token` }), {
        code: "x",
        codeVerifier: "y",
      }),
      /HTTP 400/,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
