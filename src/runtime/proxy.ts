import type { SecurityScheme, ToolDef } from "../types.js";
import { buildAuthInjection, type CredentialStore } from "./auth.js";

export interface ProxyContext {
  baseUrl: string;
  schemes: Record<string, SecurityScheme>;
  creds: CredentialStore;
  /** Optional hook for request/response logging (the Usage Logs feature). */
  onLog?: (entry: RequestLog) => void;
  /**
   * Called with the tool's OAuth2 scheme names after a 401, to refresh the
   * access token(s). Returning true means a token was refreshed (creds updated
   * in place), so the call is retried once. Enables OAuth token auto-refresh.
   */
  onUnauthorized?: (oauthSchemes: string[]) => Promise<boolean>;
  /**
   * Max automatic retries for transient upstream failures: network errors, or
   * a 5xx response to a method with no side effects to duplicate (GET, HEAD,
   * OPTIONS, PUT, DELETE — never POST/PATCH, to avoid re-running a write whose
   * response was merely lost). Default 2; set 0 to disable.
   */
  maxRetries?: number;
}

export interface RequestLog {
  tool: string;
  method: string;
  url: string;
  statusCode?: number;
  latencyMs: number;
  error?: string;
  /** JSON of the tool arguments (never contains injected credentials). */
  requestBody?: string;
  /** Upstream response body, truncated for storage. */
  responseBody?: string;
}

/** Cap stored payloads so the log store doesn't balloon on large responses. */
const MAX_PAYLOAD_CHARS = 8192;

/** 5xx statuses worth an automatic retry — gateway hiccups and generic server errors. */
const RETRYABLE_STATUSES = new Set([500, 502, 503, 504]);
/** Methods with no side effect to duplicate if a retried call actually lands twice. */
const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);
const DEFAULT_MAX_RETRIES = 2;
const RETRY_BASE_DELAY_MS = 250;
const RETRY_MAX_DELAY_MS = 2000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Full jitter exponential backoff, capped, so concurrent retries don't sync up. */
function backoffDelay(attempt: number): number {
  const cap = Math.min(RETRY_BASE_DELAY_MS * 2 ** attempt, RETRY_MAX_DELAY_MS);
  return Math.random() * cap;
}

function truncate(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS
    ? `${text.slice(0, MAX_PAYLOAD_CHARS)}… [truncated ${text.length - MAX_PAYLOAD_CHARS} chars]`
    : text;
}

export interface ProxyResult {
  statusCode: number;
  ok: boolean;
  body: string;
  contentType: string | null;
}

/**
 * Execute one upstream HTTP call for a tool invocation: substitute path params,
 * build the query string, attach headers and body, inject auth, and return the
 * normalized response. All user credentials stay server-side.
 */
export async function executeTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ProxyContext,
): Promise<ProxyResult> {
  const start = performance.now();
  const maxRetries = ctx.maxRetries ?? DEFAULT_MAX_RETRIES;
  const canRetryStatus = IDEMPOTENT_METHODS.has(tool.method.toUpperCase());
  let url = "";

  for (let attempt = 0; ; attempt++) {
    try {
      let built = buildRequest(tool, args, ctx);
      url = built.url.toString();

      let response = await fetch(built.url, {
        method: tool.method,
        headers: built.headers,
        body: built.body,
      });

      // On a 401 for an OAuth2-secured tool, refresh the token and retry once.
      if (response.status === 401 && ctx.onUnauthorized) {
        const oauthSchemes = tool.security.filter(
          (s) => ctx.schemes[s]?.type === "oauth2",
        );
        if (oauthSchemes.length && (await ctx.onUnauthorized(oauthSchemes))) {
          built = buildRequest(tool, args, ctx); // creds updated in place by refresh
          response = await fetch(built.url, {
            method: tool.method,
            headers: built.headers,
            body: built.body,
          });
        }
      }

      if (
        canRetryStatus &&
        RETRYABLE_STATUSES.has(response.status) &&
        attempt < maxRetries
      ) {
        console.error(
          `⚠ ${tool.method} ${url} → ${response.status}; retrying (${attempt + 1}/${maxRetries})…`,
        );
        await sleep(backoffDelay(attempt));
        continue;
      }

      const contentType = response.headers.get("content-type");
      const body = await response.text();
      const result: ProxyResult = {
        statusCode: response.status,
        ok: response.ok,
        body,
        contentType,
      };

      ctx.onLog?.({
        tool: tool.name,
        method: tool.method,
        url: redactUrl(built.url),
        statusCode: response.status,
        latencyMs: Math.round(performance.now() - start),
        requestBody: truncate(JSON.stringify(args)),
        responseBody: truncate(body),
      });
      return result;
    } catch (err) {
      if (attempt < maxRetries) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `⚠ ${tool.method} ${url || tool.pathTemplate} failed (${message}); retrying (${attempt + 1}/${maxRetries})…`,
        );
        await sleep(backoffDelay(attempt));
        continue;
      }

      const message = err instanceof Error ? err.message : String(err);
      ctx.onLog?.({
        tool: tool.name,
        method: tool.method,
        url,
        latencyMs: Math.round(performance.now() - start),
        error: message,
        requestBody: truncate(JSON.stringify(args)),
      });
      throw new Error(`Upstream request failed: ${message}`);
    }
  }
}

interface BuiltRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

function buildRequest(
  tool: ToolDef,
  args: Record<string, unknown>,
  ctx: ProxyContext,
): BuiltRequest {
  let path = tool.pathTemplate;
  const query = new URLSearchParams();
  const headers: Record<string, string> = { Accept: "application/json" };

  for (const param of tool.params) {
    const value = args[param.name];
    if (value === undefined || value === null) {
      if (param.required) {
        throw new Error(`Missing required parameter "${param.name}".`);
      }
      continue;
    }

    switch (param.location) {
      case "path":
        path = path.replace(
          new RegExp(`\\{${escapeRegex(param.sourceName)}\\}`, "g"),
          encodeURIComponent(stringify(value)),
        );
        break;
      case "query":
        serializeQuery(query, param, value);
        break;
      case "header":
        headers[param.sourceName] = stringify(value);
        break;
      case "cookie":
        headers["Cookie"] = appendCookie(
          headers["Cookie"],
          param.sourceName,
          stringify(value),
        );
        break;
    }
  }

  let body: string | undefined;
  if (tool.body) {
    const bodyValue = args.body;
    if (bodyValue === undefined && tool.body.required) {
      throw new Error(`Missing required request body argument "body".`);
    }
    if (bodyValue !== undefined) {
      body = JSON.stringify(bodyValue);
      headers["Content-Type"] = tool.body.contentType.includes("json")
        ? "application/json"
        : tool.body.contentType;
    }
  }

  // Inject credentials last so they take precedence and are never overridden.
  const auth = buildAuthInjection(tool.security, ctx.schemes, ctx.creds);
  Object.assign(headers, auth.headers);
  for (const [k, v] of Object.entries(auth.query)) query.set(k, v);

  const url = new URL(joinUrl(ctx.baseUrl, path));
  for (const [k, v] of query.entries()) url.searchParams.append(k, v);

  return { url, headers, body };
}

/**
 * Serialize a query parameter according to its OpenAPI `style` + `explode`.
 * Covers the encodings real specs use: form (default, explode and joined),
 * space/pipe-delimited arrays, and deepObject / form object encodings.
 */
function serializeQuery(
  query: URLSearchParams,
  param: { sourceName: string; style: import("../types.js").ParamStyle; explode: boolean },
  value: unknown,
): void {
  const key = param.sourceName;

  if (Array.isArray(value)) {
    const items = value.map(stringify);
    if (param.explode) {
      // form/spaceDelimited/pipeDelimited + explode → one pair per item.
      for (const v of items) query.append(key, v);
      return;
    }
    const sep =
      param.style === "spaceDelimited" ? " " : param.style === "pipeDelimited" ? "|" : ",";
    query.append(key, items.join(sep));
    return;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (param.style === "deepObject") {
      // deepObject → key[prop]=value (always exploded).
      for (const [k, v] of entries) query.append(`${key}[${k}]`, stringify(v));
      return;
    }
    if (param.explode) {
      // form + explode → prop=value for each property (key itself dropped).
      for (const [k, v] of entries) query.append(k, stringify(v));
      return;
    }
    // form, no explode → key=prop1,value1,prop2,value2
    query.append(key, entries.map(([k, v]) => `${k},${stringify(v)}`).join(","));
    return;
  }

  query.append(key, stringify(value));
}

function appendCookie(existing: string | undefined, key: string, value: string): string {
  const pair = `${key}=${value}`;
  return existing ? `${existing}; ${pair}` : pair;
}

function stringify(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}

function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  const p = path.startsWith("/") ? path : `/${path}`;
  return b + p;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Strip query string from a URL for safer logging. */
function redactUrl(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
