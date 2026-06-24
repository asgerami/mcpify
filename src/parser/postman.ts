import type { JsonSchema } from "../types.js";
import type {
  OpenAPIDoc,
  Operation,
  PathItem,
  RawParameter,
  RawSecurityScheme,
} from "./openapi.js";

/**
 * Convert a Postman Collection (v2.0 / v2.1) into our internal OpenAPI canonical
 * form, so the rest of the pipeline (generator, runtime) is format-agnostic.
 *
 * Postman collections are request-oriented rather than schema-oriented, so the
 * mapping is best-effort: requests become operations, URL query/path/header
 * params become parameters, raw-JSON bodies become object request bodies, and
 * collection/request auth becomes security schemes.
 */

export interface PostmanCollection {
  info?: { name?: string; schema?: string; _postman_id?: string };
  item?: PostmanItem[];
  variable?: PostmanVariable[];
  auth?: PostmanAuth;
}

interface PostmanItem {
  name?: string;
  description?: string;
  item?: PostmanItem[]; // folder
  request?: PostmanRequest; // leaf request
}

interface PostmanRequest {
  method?: string;
  url?: string | PostmanUrl;
  header?: PostmanHeader[];
  body?: { mode?: string; raw?: string; options?: { raw?: { language?: string } } };
  description?: string;
  auth?: PostmanAuth;
}

interface PostmanUrl {
  raw?: string;
  protocol?: string;
  host?: string[] | string;
  port?: string;
  path?: Array<string | { value?: string }>;
  query?: Array<{ key?: string; value?: string; disabled?: boolean; description?: string }>;
  variable?: Array<{ key?: string; value?: string; description?: string }>;
}

interface PostmanHeader {
  key?: string;
  value?: string;
  disabled?: boolean;
  description?: string;
}

interface PostmanVariable {
  key?: string;
  value?: string;
}

interface PostmanAuth {
  type?: string;
  [key: string]: unknown;
}

/** Detect whether a parsed JSON object looks like a Postman collection. */
export function isPostmanCollection(raw: unknown): raw is PostmanCollection {
  if (!raw || typeof raw !== "object") return false;
  const obj = raw as Record<string, unknown>;
  const info = obj.info as Record<string, unknown> | undefined;
  const schema = typeof info?.schema === "string" ? info.schema : "";
  return (
    schema.includes("getpostman.com") ||
    (!!info?._postman_id && Array.isArray(obj.item)) ||
    // OpenAPI docs never have a top-level `item` array; Postman always does.
    (Array.isArray(obj.item) && !("openapi" in obj) && !("swagger" in obj))
  );
}

/** Headers we never surface as tool parameters (auth/content negotiation). */
const SKIP_HEADERS = new Set([
  "authorization",
  "content-type",
  "accept",
  "user-agent",
  "host",
]);

export function postmanToOpenAPI(collection: PostmanCollection): OpenAPIDoc {
  const vars = collectVariables(collection.variable);
  const paths: Record<string, PathItem> = {};
  const securitySchemes: Record<string, RawSecurityScheme> = {};
  let baseUrl: string | undefined;
  let skippedDuplicates = 0;

  const visit = (items: PostmanItem[] | undefined): void => {
    for (const item of items ?? []) {
      if (item.item) {
        visit(item.item); // folder — recurse
        continue;
      }
      if (!item.request) continue;

      const req = item.request;
      const method = (req.method ?? "GET").toLowerCase();
      const url = normalizeUrl(req.url);

      const derivedBase = deriveBaseUrl(url, vars);
      if (derivedBase && !baseUrl) baseUrl = derivedBase;

      const pathTemplate = buildPath(url);
      const operation = toOperation(item, req, url);

      // Map auth (request-level overrides collection-level) to a security scheme.
      const auth = req.auth ?? collection.auth;
      const schemeName = registerAuth(auth, securitySchemes);
      if (schemeName) operation.security = [{ [schemeName]: [] }];

      const pathItem = (paths[pathTemplate] ??= {});
      if (pathItem[method]) {
        skippedDuplicates++;
        continue; // one operation per (path, method); keep the first
      }
      pathItem[method] = operation;
    }
  };
  visit(collection.item);

  if (skippedDuplicates > 0) {
    // Surface lossy conversion rather than silently dropping requests.
    console.error(
      `⚠ Postman: ${skippedDuplicates} duplicate (method, path) request(s) ` +
        `were skipped — only the first of each is exposed as a tool.`,
    );
  }

  return {
    openapi: "3.0.0",
    info: {
      title: collection.info?.name ?? "postman-collection",
      version: "1.0.0",
    },
    servers: baseUrl ? [{ url: baseUrl }] : undefined,
    paths,
    components: Object.keys(securitySchemes).length
      ? { securitySchemes }
      : undefined,
  };
}

function toOperation(
  item: PostmanItem,
  req: PostmanRequest,
  url: PostmanUrl,
): Operation {
  const params: RawParameter[] = [];

  // Path variables: from `:segment` tokens and url.variable descriptions.
  const pathVarDescriptions = new Map(
    (url.variable ?? []).map((v) => [v.key, v.description]),
  );
  for (const segment of url.path ?? []) {
    const raw = typeof segment === "string" ? segment : (segment?.value ?? "");
    if (raw.startsWith(":")) {
      const name = raw.slice(1);
      params.push({
        name,
        in: "path",
        required: true,
        description: pathVarDescriptions.get(name),
        schema: { type: "string" },
      });
    }
  }

  // Query parameters.
  for (const q of url.query ?? []) {
    if (!q.key || q.disabled) continue;
    params.push({
      name: q.key,
      in: "query",
      required: false,
      description: q.description,
      schema: { type: "string" },
    });
  }

  // Header parameters (excluding auth/content-negotiation headers).
  for (const h of req.header ?? []) {
    if (!h.key || h.disabled || SKIP_HEADERS.has(h.key.toLowerCase())) continue;
    params.push({
      name: h.key,
      in: "header",
      required: false,
      description: h.description,
      schema: { type: "string" },
    });
  }

  const op: Operation = {
    operationId: item.name,
    summary: item.name,
    description: req.description ?? item.description,
    parameters: params,
  };

  const body = toRequestBody(req);
  if (body) op.requestBody = body;

  return op;
}

function toRequestBody(req: PostmanRequest): Operation["requestBody"] | undefined {
  const body = req.body;
  if (!body || body.mode !== "raw" || !body.raw) return undefined;

  const isJson =
    body.options?.raw?.language === "json" || looksLikeJson(body.raw);
  if (!isJson) return undefined;

  // Infer a shallow object schema from the example payload when possible.
  let schema: JsonSchema = { type: "object" };
  try {
    const parsed = JSON.parse(body.raw);
    schema = inferSchema(parsed);
  } catch {
    // Postman bodies often contain {{variables}} that aren't valid JSON — that's
    // fine, we still expose a generic object body.
  }

  return {
    required: true,
    content: { "application/json": { schema } },
  };
}

/** Shallow JSON-Schema inference from an example value (one level deep). */
function inferSchema(value: unknown): JsonSchema {
  if (Array.isArray(value)) {
    return { type: "array", items: value.length ? inferSchema(value[0]) : {} };
  }
  if (value && typeof value === "object") {
    const properties: Record<string, JsonSchema> = {};
    for (const [k, v] of Object.entries(value)) properties[k] = inferScalar(v);
    return { type: "object", properties };
  }
  return inferScalar(value);
}

function inferScalar(value: unknown): JsonSchema {
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") {
    return { type: Number.isInteger(value) ? "integer" : "number" };
  }
  if (Array.isArray(value)) return { type: "array" };
  if (value && typeof value === "object") return { type: "object" };
  return {};
}

/** Map a Postman auth block to a security scheme; returns the scheme name. */
function registerAuth(
  auth: PostmanAuth | undefined,
  schemes: Record<string, RawSecurityScheme>,
): string | undefined {
  if (!auth?.type) return undefined;
  switch (auth.type) {
    case "bearer":
      schemes.bearerAuth = { type: "http", scheme: "bearer" };
      return "bearerAuth";
    case "basic":
      schemes.basicAuth = { type: "http", scheme: "basic" };
      return "basicAuth";
    case "apikey": {
      const cfg = readApiKeyConfig(auth);
      schemes.apiKeyAuth = { type: "apiKey", in: cfg.in, name: cfg.name };
      return "apiKeyAuth";
    }
    default:
      return undefined; // oauth2 / others are not modelled by the runtime yet
  }
}

function readApiKeyConfig(auth: PostmanAuth): { in: "header" | "query"; name: string } {
  // Postman stores apikey config either as {key,value,in} fields or an array.
  const entries = Array.isArray(auth.apikey)
    ? (auth.apikey as Array<{ key?: string; value?: string }>)
    : [];
  const get = (k: string): string | undefined => {
    if (typeof auth[k] === "string") return auth[k] as string;
    return entries.find((e) => e.key === k)?.value;
  };
  const location = get("in") === "query" ? "query" : "header";
  const name = get("key") || "X-API-Key";
  return { in: location, name };
}

// ---- URL helpers ----

function normalizeUrl(url: string | PostmanUrl | undefined): PostmanUrl {
  if (!url) return {};
  if (typeof url === "string") return parseRawUrl(url);
  // Some collections only populate `raw`; backfill structured fields from it.
  if (url.raw && (!url.host || !url.path)) {
    return { ...parseRawUrl(url.raw), ...stripEmpty(url) };
  }
  return url;
}

function parseRawUrl(raw: string): PostmanUrl {
  // Keep {{variables}} intact; split host/path/query without a full URL parse.
  const [beforeQuery, queryString] = raw.split("?");
  const protoMatch = beforeQuery.match(/^([a-zA-Z]+):\/\//);
  const protocol = protoMatch?.[1];
  const rest = protoMatch ? beforeQuery.slice(protoMatch[0].length) : beforeQuery;
  const slash = rest.indexOf("/");
  const hostPart = slash === -1 ? rest : rest.slice(0, slash);
  const pathPart = slash === -1 ? "" : rest.slice(slash + 1);

  const query = (queryString ? queryString.split("&") : [])
    .filter(Boolean)
    .map((pair) => {
      const [key, value] = pair.split("=");
      return { key, value };
    });

  return {
    protocol,
    host: hostPart ? hostPart.split(".") : [],
    path: pathPart ? pathPart.split("/").filter(Boolean) : [],
    query,
  };
}

function buildPath(url: PostmanUrl): string {
  const segments = (url.path ?? []).map((s) => {
    const raw = typeof s === "string" ? s : (s?.value ?? "");
    // Postman path variables `:id` → OpenAPI `{id}`.
    return raw.startsWith(":") ? `{${raw.slice(1)}}` : raw;
  });
  return "/" + segments.join("/");
}

function deriveBaseUrl(
  url: PostmanUrl,
  vars: Map<string, string>,
): string | undefined {
  const host = Array.isArray(url.host)
    ? url.host.join(".")
    : (url.host ?? "");
  if (!host) return undefined;

  const resolvedHost = resolveVars(host, vars);
  // If the host is itself a fully-qualified variable (e.g. {{baseUrl}}), use it.
  if (/^https?:\/\//.test(resolvedHost)) {
    return resolvedHost.replace(/\/+$/, "");
  }
  const protocol = url.protocol ?? "https";
  const port = url.port ? `:${url.port}` : "";
  return `${protocol}://${resolvedHost}${port}`;
}

function resolveVars(text: string, vars: Map<string, string>): string {
  return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => vars.get(key) ?? match);
}

function collectVariables(variables: PostmanVariable[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const v of variables ?? []) {
    if (v.key) map.set(v.key, v.value ?? "");
  }
  return map;
}

function stripEmpty(url: PostmanUrl): Partial<PostmanUrl> {
  const out: Partial<PostmanUrl> = {};
  if (url.host && (Array.isArray(url.host) ? url.host.length : url.host)) out.host = url.host;
  if (url.path?.length) out.path = url.path;
  if (url.query?.length) out.query = url.query;
  if (url.protocol) out.protocol = url.protocol;
  if (url.port) out.port = url.port;
  if (url.variable?.length) out.variable = url.variable;
  return out;
}

function looksLikeJson(raw: string): boolean {
  const trimmed = raw.trim();
  return trimmed.startsWith("{") || trimmed.startsWith("[");
}
