import type {
  JsonSchema,
  ParamLocation,
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

      tools.push({
        name,
        description: describe(op, method, pathTemplate),
        method: method.toUpperCase(),
        pathTemplate,
        params,
        body,
        security,
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
  return {
    name: sanitize(p.name),
    sourceName: p.name,
    location,
    required: p.required ?? location === "path", // path params are always required
    description: p.description,
    schema: p.schema ?? { type: "string" },
  };
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
    schema: schema ?? { type: "object" },
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
