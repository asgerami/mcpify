import type {
  JsonSchema,
  ParamLocation,
  ParamStyle,
  SecurityScheme,
  ToolDef,
  ToolParam,
} from "../types.js";
import {
  HTTP_METHODS,
  type OpenAPIDoc,
  type Operation,
  type RawParameter,
} from "../parser/openapi.js";

/**
 * Structural generation pass: deterministically map every (path, method)
 * operation to an MCP tool definition. No LLM involved — that is the future
 * semantic-enrichment pass, which would refine `name`/`description` here.
 */
export function buildTools(
  api: OpenAPIDoc,
  securitySchemes: Record<string, SecurityScheme>,
): ToolDef[] {
  const tools: ToolDef[] = [];
  const usedNames = new Set<string>();
  const paths = api.paths ?? {};

  for (const [pathTemplate, item] of Object.entries(paths)) {
    if (!item) continue;
    // Parameters can be declared at the path level and shared by all methods.
    const sharedParams = (item.parameters as RawParameter[] | undefined) ?? [];

    for (const method of HTTP_METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op || typeof op !== "object") continue;

      const name = uniqueName(
        toolName(op, method, pathTemplate),
        usedNames,
      );

      const params = mergeParams(sharedParams, op.parameters ?? []).map(
        toToolParam,
      );
      const body = extractBody(op);
      const security = resolveSecurity(op, api, securitySchemes);
      const outputSchema = extractOutputSchema(op);

      tools.push({
        name,
        description: describe(op, method, pathTemplate),
        method: method.toUpperCase(),
        pathTemplate,
        params,
        body,
        security,
        tags: op.tags?.length ? [...op.tags] : undefined,
        outputSchema,
      });
    }
  }

  return tools;
}

/** Prefer operationId; otherwise synthesize `method_path_segments`. */
function toolName(op: Operation, method: string, path: string): string {
  if (op.operationId) return sanitize(op.operationId);
  const segments = path
    .split("/")
    .filter(Boolean)
    .map((s) => s.replace(/\{([^}]+)\}/g, "by_$1"));
  return sanitize([method, ...segments].join("_"));
}

/** MCP tool names: letters, digits, underscores; collapse the rest. */
function sanitize(raw: string): string {
  const cleaned = raw
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  return cleaned || "tool";
}

function uniqueName(base: string, used: Set<string>): string {
  let name = base;
  let i = 2;
  while (used.has(name)) name = `${base}_${i++}`;
  used.add(name);
  return name;
}

function describe(op: Operation, method: string, path: string): string {
  const parts: string[] = [];
  if (op.summary) parts.push(op.summary.trim());
  if (op.description && op.description.trim() !== op.summary?.trim()) {
    parts.push(op.description.trim());
  }
  if (parts.length === 0) {
    parts.push(`${method.toUpperCase()} ${path}`);
  }
  // Always anchor the description with the concrete call for agent clarity.
  parts.push(`(HTTP ${method.toUpperCase()} ${path})`);
  return parts.join("\n\n");
}

/** Later params override earlier ones with the same (name, in) key. */
function mergeParams(
  shared: RawParameter[],
  own: RawParameter[],
): RawParameter[] {
  const byKey = new Map<string, RawParameter>();
  for (const p of [...shared, ...own]) {
    if (!p?.name || !p?.in) continue;
    byKey.set(`${p.in}:${p.name}`, p);
  }
  return [...byKey.values()];
}

function toToolParam(p: RawParameter): ToolParam {
  const location = (p.in as ParamLocation) ?? "query";
  const style = normalizeStyle(p.style, location);
  return {
    name: sanitize(p.name),
    sourceName: p.name,
    location,
    required: p.required ?? location === "path", // path params are always required
    description: p.description,
    schema: pruneCycles(p.schema) ?? { type: "string" },
    style,
    // OpenAPI default: explode is true for `form`, false for every other style.
    explode: p.explode ?? style === "form",
  };
}

/**
 * Dereferenced OpenAPI documents inline recursive `$ref`s as genuine circular
 * JavaScript references (common in large specs like Stripe). Those objects
 * cannot be JSON-serialized for storage or the MCP wire format, and would send
 * the schema-to-zod conversion into infinite recursion. Return a structural
 * copy in which every object node is expanded at most once: the first time a
 * node is reached it is copied in full; any later reference to the same node —
 * whether a recursive back-edge or a subschema shared across many fields —
 * collapses to a permissive `{}` (JSON Schema for "any").
 *
 * Expanding each node once is what keeps this bounded. Cutting only true cycles
 * would leave the object graph acyclic but still let a heavily shared subschema
 * (Stripe's giant `anyOf` unions reuse the same objects hundreds of times)
 * serialize to gigabytes of duplicated text. Emit-once bounds the output to the
 * size of the reachable graph at the cost of showing repeated schemas in full
 * only on their first occurrence within a tool, which is an acceptable trade for
 * a self-contained tool schema.
 *
 * A depth cap on top of that keeps individual tool schemas lean enough to be
 * useful to an agent: some specs nest distinct objects dozens of levels deep,
 * and a multi-hundred-KB `inputSchema` is noise no model will read. Beyond the
 * cap we substitute `{}`; the useful top-level shape survives.
 */
const MAX_SCHEMA_DEPTH = 12;

function pruneCycles(schema: JsonSchema | undefined): JsonSchema | undefined {
  if (schema === undefined) return undefined;
  return prune(schema, new Set(), 0) as JsonSchema;
}

function prune(node: unknown, seen: Set<object>, depth: number): unknown {
  if (node === null || typeof node !== "object") return node;
  const obj = node as object;
  if (depth > MAX_SCHEMA_DEPTH || seen.has(obj)) {
    return Array.isArray(node) ? [] : {};
  }
  seen.add(obj);
  if (Array.isArray(node)) {
    return node.map((v) => prune(v, seen, depth + 1));
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    out[k] = prune(v, seen, depth + 1);
  }
  return out;
}

/** Resolve the serialization style, applying OpenAPI's per-location defaults. */
function normalizeStyle(style: string | undefined, location: ParamLocation): ParamStyle {
  const known: ParamStyle[] = [
    "form",
    "simple",
    "spaceDelimited",
    "pipeDelimited",
    "deepObject",
  ];
  if (style && (known as string[]).includes(style)) return style as ParamStyle;
  // Defaults: query/cookie → form; path/header → simple.
  return location === "query" || location === "cookie" ? "form" : "simple";
}

/**
 * Extract the success-response schema for the tool's `outputSchema`. We only
 * keep it when the response is a JSON object — MCP output schemas must be
 * objects, and array/primitive bodies are surfaced via text content instead.
 */
function extractOutputSchema(op: Operation): JsonSchema | undefined {
  const responses = op.responses;
  if (!responses) return undefined;

  // Prefer the lowest 2xx status, then a `default` response.
  const successKey =
    Object.keys(responses)
      .filter((k) => /^2\d\d$/.test(k))
      .sort()[0] ?? (responses.default ? "default" : undefined);
  if (!successKey) return undefined;

  const content = responses[successKey]?.content;
  if (!content) return undefined;

  const jsonType =
    Object.keys(content).find((c) => c.includes("json")) ?? Object.keys(content)[0];
  const schema = jsonType ? (content[jsonType]?.schema as JsonSchema | undefined) : undefined;
  if (!schema) return undefined;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  const isObject = type === "object" || (!type && !!schema.properties);
  return isObject ? pruneCycles(schema) : undefined;
}

/** Pick a JSON request body, preferring application/json. */
function extractBody(op: Operation): ToolDef["body"] {
  const content = op.requestBody?.content;
  if (!content) return undefined;

  const contentType =
    Object.keys(content).find((c) => c.includes("json")) ??
    Object.keys(content)[0];
  if (!contentType) return undefined;

  const schema = content[contentType]?.schema as JsonSchema | undefined;
  return {
    required: op.requestBody?.required ?? false,
    description: op.requestBody?.description,
    contentType,
    schema: pruneCycles(schema) ?? { type: "object" },
  };
}

/**
 * Resolve which security schemes apply: operation-level overrides global.
 * We return scheme names we actually support; unknown schemes are dropped.
 */
function resolveSecurity(
  op: Operation,
  api: OpenAPIDoc,
  supported: Record<string, SecurityScheme>,
): string[] {
  const requirements = op.security ?? api.security ?? [];
  const names = new Set<string>();
  for (const req of requirements) {
    for (const schemeName of Object.keys(req)) {
      if (supported[schemeName]) names.add(schemeName);
    }
  }
  return [...names];
}
