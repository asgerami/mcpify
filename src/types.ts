/**
 * Core domain types shared across the ingestion → generation → runtime pipeline.
 */

/** Where a parameter is placed in the outgoing HTTP request. */
export type ParamLocation = "path" | "query" | "header" | "cookie";

/**
 * How an array/object parameter is serialized into the request, per the
 * OpenAPI `style` + `explode` keywords. We map these to wire encodings in the
 * proxy. Only the styles that appear in real specs are modelled.
 */
export type ParamStyle =
  | "form"
  | "simple"
  | "spaceDelimited"
  | "pipeDelimited"
  | "deepObject";

/** A single input parameter on a generated MCP tool. */
export interface ToolParam {
  /** Property name exposed to the agent (sanitized for safety). */
  name: string;
  /** Original name in the spec (used when building the request). */
  sourceName: string;
  location: ParamLocation;
  required: boolean;
  description?: string;
  /** JSON Schema fragment for this parameter, straight from the spec. */
  schema: JsonSchema;
  /** Serialization style (OpenAPI `style`). Defaults by location. */
  style: ParamStyle;
  /** Whether array/object values explode into multiple pairs (OpenAPI `explode`). */
  explode: boolean;
}

/**
 * A request body mapped to a single `body` argument on the tool. We keep the
 * raw JSON Schema so the runtime can forward it verbatim to the upstream API.
 */
export interface ToolBody {
  required: boolean;
  description?: string;
  contentType: string;
  schema: JsonSchema;
}

/** A fully-described MCP tool, ready to be registered and proxied. */
export interface ToolDef {
  /** MCP tool name, unique within a server. */
  name: string;
  description: string;
  /** HTTP method, uppercased. */
  method: string;
  /** Path template with `{param}` placeholders, relative to baseUrl. */
  pathTemplate: string;
  params: ToolParam[];
  body?: ToolBody;
  /** Security scheme names this operation requires (OR semantics). */
  security: string[];
  /** OpenAPI operation tags — used by `--include` / `--exclude` filters. */
  tags?: string[];
  /**
   * JSON Schema of the success (2xx) response, when it is an object. Drives the
   * MCP tool's `outputSchema` so agents see the return shape and the runtime
   * can hand back `structuredContent`. Absent for array/primitive/no-schema
   * responses (MCP output schemas must be objects).
   */
  outputSchema?: JsonSchema;
}

/** The product of ingestion + generation: everything the runtime needs. */
export interface GeneratedServer {
  name: string;
  version: string;
  /** Resolved upstream base URL all requests are made against. */
  baseUrl: string;
  tools: ToolDef[];
  securitySchemes: Record<string, SecurityScheme>;
}

/** OAuth2 flows we model from an OpenAPI security scheme. */
export type OAuthFlow = "authorizationCode" | "clientCredentials";

/** Subset of OpenAPI security schemes we support today. */
export type SecurityScheme =
  | { type: "http"; scheme: "bearer" | "basic"; name: string }
  | { type: "apiKey"; in: "header" | "query" | "cookie"; paramName: string; name: string }
  | {
      type: "oauth2";
      name: string;
      /** Authorization-code flow endpoints, from the spec when present. */
      authorizationUrl?: string;
      tokenUrl?: string;
      scopes: string[];
      /** Flows advertised by the spec (drives UI + which grants we offer). */
      flows: OAuthFlow[];
    }
  | {
      type: "openIdConnect";
      name: string;
      /** OpenID Provider discovery document URL. */
      openIdConnectUrl: string;
    };

/** A permissive JSON Schema shape; we only read the fields we map. */
export interface JsonSchema {
  type?: string | string[];
  format?: string;
  description?: string;
  enum?: unknown[];
  default?: unknown;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean | JsonSchema;
  nullable?: boolean;
  [key: string]: unknown;
}
