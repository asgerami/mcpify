import { readFile } from "node:fs/promises";
import SwaggerParser from "@apidevtools/swagger-parser";
import type {
  GeneratedServer,
  JsonSchema,
  SecurityScheme,
} from "../types.js";
import { buildTools } from "../generator/tools.js";
import { isPostmanCollection, postmanToOpenAPI } from "./postman.js";

export interface ParseOptions {
  /** Override the upstream base URL (e.g. when the spec omits `servers`). */
  baseUrl?: string;
}

/**
 * Ingestion pipeline: load an API description (OpenAPI 3.x or a Postman
 * collection) from a URL or file, normalize it to canonical OpenAPI form, and
 * hand it to the generator.
 */
export async function ingest(
  specSource: string,
  opts: ParseOptions = {},
): Promise<GeneratedServer> {
  const api = await loadCanonical(specSource);

  if (!api.openapi?.startsWith("3")) {
    throw new Error(
      `Only OpenAPI 3.x is supported (got "${api.openapi ?? "unknown"}"). ` +
        `Convert Swagger 2.0 specs first.`,
    );
  }

  const baseUrl = resolveBaseUrl(api, specSource, opts.baseUrl);
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

/**
 * Load the source and normalize it to canonical OpenAPI form. A Postman
 * collection is converted in-process; otherwise swagger-parser validates and
 * dereferences `$ref`s from the original source (preserving ref resolution).
 */
async function loadCanonical(specSource: string): Promise<OpenAPIDoc> {
  const probed = await tryLoadJson(specSource);
  if (probed && isPostmanCollection(probed)) {
    return postmanToOpenAPI(probed);
  }
  // If we already fetched/parsed a JSON OpenAPI doc, dereference the object
  // directly. This avoids a second download of large specs and sidesteps
  // swagger-parser's own URL resolver (which can fail on some hosts).
  if (probed && isOpenApiObject(probed)) {
    return (await SwaggerParser.dereference(
      probed as Parameters<typeof SwaggerParser.dereference>[0],
    )) as OpenAPIDoc;
  }
  // YAML or otherwise: let swagger-parser fetch, validate, and dereference.
  return (await SwaggerParser.dereference(specSource)) as OpenAPIDoc;
}

/** Whether a parsed object is an OpenAPI/Swagger document. */
function isOpenApiObject(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.openapi === "string" || typeof obj.swagger === "string";
}

/**
 * Best-effort JSON load purely to sniff the format. Returns undefined for
 * anything that isn't fetchable/readable JSON (e.g. YAML OpenAPI), in which
 * case the caller defers to swagger-parser.
 */
async function tryLoadJson(specSource: string): Promise<unknown> {
  try {
    let text: string;
    if (/^https?:\/\//i.test(specSource)) {
      const res = await fetch(specSource);
      if (!res.ok) return undefined;
      text = await res.text();
    } else {
      text = await readFile(specSource, "utf8");
    }
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function resolveBaseUrl(api: OpenAPIDoc, specSource: string, override?: string): string {
  if (override) return stripTrailingSlash(override);
  const first = api.servers?.[0]?.url;
  if (!first) {
    throw new Error(
      "Spec has no `servers` entry and no --base-url was provided. " +
        "Pass --base-url https://api.example.com to set the upstream target.",
    );
  }
  // Server URLs can be relative or contain templated variables; resolve defaults.
  let url = applyServerVariables(first, api.servers![0].variables);

  // Relative server URLs (e.g. "/api/v3") are common; resolve them against the
  // spec's own URL so the upstream is absolute.
  if (!/^https?:\/\//i.test(url)) {
    if (/^https?:\/\//i.test(specSource)) {
      url = new URL(url, specSource).toString();
    } else {
      throw new Error(
        `The spec's server URL is relative ("${url}") and the spec was loaded ` +
          `from a file, so the upstream host is unknown. Pass --base-url ` +
          `https://api.example.com (or baseUrl) to set it.`,
      );
    }
  }
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
    } else if (raw.type === "oauth2") {
      const flows: Array<"authorizationCode" | "clientCredentials"> = [];
      if (raw.flows?.authorizationCode) flows.push("authorizationCode");
      if (raw.flows?.clientCredentials) flows.push("clientCredentials");
      // Prefer authorization-code URLs; fall back to client-credentials / any flow.
      const preferred =
        raw.flows?.authorizationCode ??
        raw.flows?.clientCredentials ??
        Object.values(raw.flows ?? {})[0];
      out[name] = {
        type: "oauth2",
        name,
        authorizationUrl: raw.flows?.authorizationCode?.authorizationUrl,
        tokenUrl: preferred?.tokenUrl,
        scopes: preferred?.scopes ? Object.keys(preferred.scopes) : [],
        flows: flows.length ? flows : ["authorizationCode"],
      };
    } else if (raw.type === "openIdConnect" && raw.openIdConnectUrl) {
      out[name] = {
        type: "openIdConnect",
        name,
        openIdConnectUrl: raw.openIdConnectUrl,
      };
    }
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
  flows?: Record<string, RawOAuthFlow | undefined>;
  openIdConnectUrl?: string;
}

export interface RawOAuthFlow {
  authorizationUrl?: string;
  tokenUrl?: string;
  refreshUrl?: string;
  scopes?: Record<string, string>;
}

export interface PathItem {
  parameters?: RawParameter[];
  [method: string]: Operation | RawParameter[] | undefined;
}

export interface Operation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  parameters?: RawParameter[];
  requestBody?: {
    description?: string;
    required?: boolean;
    content?: Record<string, { schema?: JsonSchema }>;
  };
  responses?: Record<string, RawResponse>;
  security?: Array<Record<string, string[]>>;
}

export interface RawResponse {
  description?: string;
  content?: Record<string, { schema?: JsonSchema }>;
}

export interface RawParameter {
  name: string;
  in: string;
  required?: boolean;
  description?: string;
  schema?: JsonSchema;
  /** OpenAPI serialization style; defaults depend on `in`. */
  style?: string;
  /** OpenAPI explode flag; default depends on `style`. */
  explode?: boolean;
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
