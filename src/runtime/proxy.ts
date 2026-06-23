import type { SecurityScheme, ToolDef } from "../types.js";
import { buildAuthInjection, type CredentialStore } from "./auth.js";

export interface ProxyContext {
  baseUrl: string;
  schemes: Record<string, SecurityScheme>;
  creds: CredentialStore;
  /** Optional hook for request/response logging (the Usage Logs feature). */
  onLog?: (entry: RequestLog) => void;
}

export interface RequestLog {
  tool: string;
  method: string;
  url: string;
  statusCode?: number;
  latencyMs: number;
  error?: string;
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
  let url = "";
  try {
    const built = buildRequest(tool, args, ctx);
    url = built.url.toString();

    const response = await fetch(built.url, {
      method: tool.method,
      headers: built.headers,
      body: built.body,
    });

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
    });
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.onLog?.({
      tool: tool.name,
      method: tool.method,
      url,
      latencyMs: Math.round(performance.now() - start),
      error: message,
    });
    throw new Error(`Upstream request failed: ${message}`);
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
        appendQuery(query, param.sourceName, value);
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

function appendQuery(
  query: URLSearchParams,
  key: string,
  value: unknown,
): void {
  if (Array.isArray(value)) {
    for (const v of value) query.append(key, stringify(v));
  } else {
    query.append(key, stringify(value));
  }
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
