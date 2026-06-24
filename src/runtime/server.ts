import {
  McpServer,
  type RegisteredTool,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { GeneratedServer, ToolDef } from "../types.js";
import { toolInputShape, toolOutputShape } from "../generator/schema.js";
import { diffTools, type SpecDiff } from "../generator/diff.js";
import {
  executeTool,
  type ProxyContext,
  type RequestLog,
} from "./proxy.js";
import { type CredentialStore } from "./auth.js";

export interface RuntimeOptions {
  creds: CredentialStore;
  /** Optional request/response log sink (Usage Logs). */
  onLog?: (entry: RequestLog) => void;
}

/** A live MCP server that can hot-reload its tools when the spec changes. */
export interface ReloadableServer {
  server: McpServer;
  /**
   * Apply a re-ingested spec to the running server: add/remove/update tools to
   * match, emitting `tools/list_changed` to connected clients. Returns the diff.
   */
  reload(next: GeneratedServer): SpecDiff;
}

/**
 * Build a live MCP server from a GeneratedServer description. Each tool, when
 * called by an agent, proxies through to the upstream REST API with auth
 * injected. This is the dynamic runtime — one codebase serves any spec.
 */
export function createMcpServer(
  generated: GeneratedServer,
  opts: RuntimeOptions,
): McpServer {
  return createReloadableServer(generated, opts).server;
}

/**
 * Like {@link createMcpServer} but exposes a `reload` to hot-swap tools when the
 * upstream spec changes, without dropping the client connection.
 */
export function createReloadableServer(
  generated: GeneratedServer,
  opts: RuntimeOptions,
): ReloadableServer {
  const server = new McpServer({
    name: generated.name,
    version: generated.version,
  });

  // Mutable context so reloads can repoint baseUrl/schemes without rebuilding
  // every tool callback (the callbacks close over this object by reference).
  const ctx: ProxyContext = {
    baseUrl: generated.baseUrl,
    schemes: generated.securitySchemes,
    creds: opts.creds,
    onLog: opts.onLog,
  };

  const registered = new Map<string, RegisteredTool>();
  const byName = new Map<string, ToolDef>();
  for (const tool of generated.tools) registerOne(server, tool, ctx, registered, byName);

  function reload(next: GeneratedServer): SpecDiff {
    const diff = diffTools([...byName.values()], next.tools);
    ctx.baseUrl = next.baseUrl;
    ctx.schemes = next.securitySchemes;

    const nextByName = new Map(next.tools.map((t) => [t.name, t]));

    // Removed and changed tools are torn down; changed + added are (re)created
    // with fresh schemas and a callback bound to the new ToolDef.
    for (const name of diff.removed) dropOne(name, registered, byName);
    for (const c of diff.changed) dropOne(c.name, registered, byName);
    for (const c of diff.changed) registerOne(server, nextByName.get(c.name)!, ctx, registered, byName);
    for (const name of diff.added) registerOne(server, nextByName.get(name)!, ctx, registered, byName);

    return diff;
  }

  return { server, reload };
}

function dropOne(
  name: string,
  registered: Map<string, RegisteredTool>,
  byName: Map<string, ToolDef>,
): void {
  registered.get(name)?.remove();
  registered.delete(name);
  byName.delete(name);
}

function registerOne(
  server: McpServer,
  tool: ToolDef,
  ctx: ProxyContext,
  registered: Map<string, RegisteredTool>,
  byName: Map<string, ToolDef>,
): void {
  const outputSchema = toolOutputShape(tool);
  const handle = server.registerTool(
    tool.name,
    {
      description: tool.description,
      inputSchema: toolInputShape(tool),
      ...(outputSchema ? { outputSchema } : {}),
    },
    async (args: Record<string, unknown>): Promise<CallToolResult> => {
      const result = await executeTool(tool, args ?? {}, ctx);
      const base: CallToolResult = {
        // Surface HTTP errors to the agent rather than throwing, so it can
        // adapt (retry, fix params) instead of seeing an opaque failure.
        isError: !result.ok,
        content: [
          {
            type: "text",
            text: formatResult(result.statusCode, result.ok, result.body),
          },
        ],
      };

      // When the tool declares an output schema, a successful call must carry
      // structuredContent that validates against it (the SDK enforces this).
      // Validate here and fall back to {} — the schema is all-optional, so {}
      // always passes — guaranteeing a divergent response can't crash the
      // call. The full body is always available in the text content above.
      if (outputSchema && result.ok) {
        const parsed = outputSchema.safeParse(asObject(result.body));
        base.structuredContent = parsed.success
          ? (parsed.data as Record<string, unknown>)
          : {};
      }
      return base;
    },
  );
  registered.set(tool.name, handle);
  byName.set(tool.name, tool);
}

/** Parse a response body to a plain object, or {} if it isn't one. */
function asObject(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function formatResult(status: number, ok: boolean, body: string): string {
  const prefix = ok
    ? `HTTP ${status}`
    : `HTTP ${status} (upstream error)`;
  const trimmed = body.length > 0 ? body : "(empty response body)";
  return `${prefix}\n\n${trimmed}`;
}
