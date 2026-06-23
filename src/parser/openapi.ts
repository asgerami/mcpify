import SwaggerParser from "@apidevtools/swagger-parser";
import type {
  GeneratedServer,
  JsonSchema,
  SecurityScheme,
} from "../types.js";
import { buildTools } from "../generator/tools.js";

export interface ParseOptions {
  /** Override the upstream base URL (e.g. when the spec omits `servers`). */
  baseUrl?: string;
}

/**
 * Ingestion pipeline: load an OpenAPI 3.x spec (URL, file path, JSON or YAML),
 * fully dereference `$ref`s, normalize it, and hand it to the generator.
 */
export async function ingest(
  specSource: string,
  opts: ParseOptions = {},
): Promise<GeneratedServer> {
  // swagger-parser validates, resolves remote/relative $refs, and dereferences.
  const api = (await SwaggerParser.dereference(specSource)) as OpenAPIDoc;

  if (!api.openapi?.startsWith("3")) {
    throw new Error(
      `Only OpenAPI 3.x is supported (got "${api.openapi ?? "unknown"}"). ` +
        `Convert Swagger 2.0 specs first.`,
    );
  }

  const baseUrl = resolveBaseUrl(api, opts.baseUrl);
  const securitySchemes = mapSecuritySchemes(api);
  const tools = buildTools(api, securitySchemes);

  return {
    name: api.info?.title ?? "mcp-server",
    version: api.info?.version ?? "0.0.0",
    baseUrl,
    tools,
    securitySchemes,
  };
}

function resolveBaseUrl(api: OpenAPIDoc, override?: string): string {
  if (override) return stripTrailingSlash(override);
  const first = api.servers?.[0]?.url;
  if (!first) {
    throw new Error(
      "Spec has no `servers` entry and no --base-url was provided. " +
        "Pass --base-url https://api.example.com to set the upstream target.",
    );
  }
  // Server URLs can be relative or contain templated variables; resolve defaults.
  const url = applyServerVariables(first, api.servers![0].variables);
  return stripTrailingSlash(url);
}

function applyServerVariables(
  url: string,
  variables?: Record<string, { default?: string }>,
): string {
  if (!variables) return url;
  return url.replace(/\{([^}]+)\}/g, (match, key) => {
    const def = variables[key]?.default;
    return def ?? match;
  });
}

function mapSecuritySchemes(api: OpenAPIDoc): Record<string, SecurityScheme> {
  const out: Record<string, SecurityScheme> = {};
  const schemes = api.components?.securitySchemes ?? {};
  for (const [name, raw] of Object.entries(schemes)) {
    if (!raw || typeof raw !== "object") continue;
    if (raw.type === "http" && (raw.scheme === "bearer" || raw.scheme === "basic")) {
      out[name] = { type: "http", scheme: raw.scheme, name };
    } else if (raw.type === "apiKey" && raw.in && raw.name) {
      out[name] = {
        type: "apiKey",
        in: raw.in as "header" | "query" | "cookie",
        paramName: raw.name,
        name,
      };
    }
    // oauth2 / openIdConnect are intentionally skipped for the MVP runtime.
  }
  return out;
}

function stripTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// ---- Minimal structural typing for the bits of OpenAPI we read ----

export interface OpenAPIDoc {
  openapi?: string;
  info?: { title?: string; version?: string };
  servers?: Array<{
    url: string;
    variables?: Record<string, { default?: string }>;
  }>;
  paths?: Record<string, PathItem>;
  components?: {
    securitySchemes?: Record<string, RawSecurityScheme>;
  };
  security?: Array<Record<string, string[]>>;
}

export interface RawSecurityScheme {
  type?: string;
  scheme?: string;
  in?: string;
  name?: string;
}

export interface PathItem {
  parameters?: RawParameter[];
  [method: string]: Operation | RawParameter[] | undefined;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: RawParameter[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  security?: Array<Record<string, string[]>>;
}

export interface RawParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
}

export const HTTP_METHODS = [
  "get",
  "put",
  "post",
  "delete",
  "patch",
  "options",
  "head",
] as const;
