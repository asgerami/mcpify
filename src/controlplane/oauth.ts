import { createHash, randomBytes } from "node:crypto";

/**
 * OAuth 2.0 authorization-code flow primitives (RFC 6749 + PKCE, RFC 7636).
 * Pure functions over config: build the authorization URL the user visits,
 * exchange the returned code for tokens, and refresh an expired access token.
 * The manager layer stores the results (encrypted) and injects the access
 * token into upstream calls.
 */

export interface OAuthConfig {
  authorizationUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret?: string;
  redirectUri: string;
  scopes: string[];
}

export interface TokenSet {
  accessToken: string;
  refreshToken?: string;
  /** Epoch ms when the access token expires, if the provider said so. */
  expiresAt?: number;
  scope?: string;
  tokenType?: string;
}

/** A cryptographically-random PKCE verifier (base64url, 43 chars). */
export function generateCodeVerifier(): string {
  return base64url(randomBytes(32));
}

/** The S256 PKCE challenge for a verifier. */
export function codeChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier).digest());
}

/** Opaque anti-CSRF state value. */
export function generateState(): string {
  return base64url(randomBytes(16));
}

/** Build the authorization URL the user is redirected to. */
export function buildAuthorizeUrl(
  config: OAuthConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(config.authorizationUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  if (config.scopes.length) url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

/** Exchange an authorization code for tokens at the token endpoint. */
export async function exchangeCode(
  config: OAuthConfig,
  args: { code: string; codeVerifier: string },
  timeoutMs = 10_000,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: args.code,
    redirect_uri: config.redirectUri,
    client_id: config.clientId,
    code_verifier: args.codeVerifier,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  return tokenRequest(config.tokenUrl, body, timeoutMs);
}

/** Use a refresh token to obtain a fresh access token. */
export async function refreshTokens(
  config: OAuthConfig,
  refreshToken: string,
  timeoutMs = 10_000,
): Promise<TokenSet> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: config.clientId,
  });
  if (config.clientSecret) body.set("client_secret", config.clientSecret);
  const next = await tokenRequest(config.tokenUrl, body, timeoutMs);
  // Providers may omit a new refresh token; keep the existing one.
  if (!next.refreshToken) next.refreshToken = refreshToken;
  return next;
}

/**
 * Machine-to-machine: exchange client_id + client_secret for an access token
 * (OAuth 2.0 client_credentials grant). No user redirect.
 */
export async function clientCredentialsGrant(
  config: Pick<OAuthConfig, "tokenUrl" | "clientId" | "clientSecret" | "scopes">,
  timeoutMs = 10_000,
): Promise<TokenSet> {
  if (!config.clientSecret) {
    throw new Error("client_credentials grant requires a clientSecret.");
  }
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: config.clientId,
    client_secret: config.clientSecret,
  });
  if (config.scopes.length) body.set("scope", config.scopes.join(" "));
  return tokenRequest(config.tokenUrl, body, timeoutMs);
}

/** Endpoints resolved from an OpenID Connect discovery document. */
export interface OidcDiscovery {
  authorizationUrl: string;
  tokenUrl: string;
}

/**
 * Fetch an OpenID Provider's discovery document and pull the authorize/token
 * endpoints Wrangl needs for the authorization-code or client_credentials flow.
 */
export async function discoverOidc(
  openIdConnectUrl: string,
  timeoutMs = 10_000,
): Promise<OidcDiscovery> {
  const res = await fetch(openIdConnectUrl, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      `OIDC discovery returned HTTP ${res.status}: ${text.slice(0, 300)}`,
    );
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`OIDC discovery returned non-JSON: ${text.slice(0, 200)}`);
  }
  const authorizationUrl = json.authorization_endpoint;
  const tokenUrl = json.token_endpoint;
  if (typeof authorizationUrl !== "string" || typeof tokenUrl !== "string") {
    throw new Error(
      "OIDC discovery document missing authorization_endpoint or token_endpoint.",
    );
  }
  return { authorizationUrl, tokenUrl };
}

/** Is the access token missing or within `skewMs` of expiry? */
export function isExpired(tokens: TokenSet, skewMs = 60_000): boolean {
  if (!tokens.accessToken) return true;
  if (tokens.expiresAt === undefined) return false; // no expiry known
  return Date.now() >= tokens.expiresAt - skewMs;
}

async function tokenRequest(
  tokenUrl: string,
  body: URLSearchParams,
  timeoutMs: number,
): Promise<TokenSet> {
  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Token endpoint returned HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`Token endpoint returned non-JSON: ${text.slice(0, 200)}`);
  }
  if (typeof json.access_token !== "string") {
    throw new Error(`Token response missing access_token: ${text.slice(0, 200)}`);
  }

  const expiresIn = typeof json.expires_in === "number" ? json.expires_in : undefined;
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: expiresIn !== undefined ? Date.now() + expiresIn * 1000 : undefined,
    scope: typeof json.scope === "string" ? json.scope : undefined,
    tokenType: typeof json.token_type === "string" ? json.token_type : undefined,
  };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
