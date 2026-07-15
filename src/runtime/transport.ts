import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/** Connect the MCP server to stdio — the transport Claude Desktop uses. */
export async function serveStdio(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

export interface HttpServeOptions {
  port: number;
  host?: string;
  /** Path the MCP endpoint is mounted at. */
  path?: string;
}

/**
 * Serve the MCP server over Streamable HTTP — the transport the hosted product
 * exposes at `mcp.wrangl.io/servers/{slug}`. Stateful sessions are keyed by the
 * `mcp-session-id` header and reused across requests.
 */
export async function serveHttp(
  build: () => McpServer,
  opts: HttpServeOptions,
): Promise<() => Promise<void>> {
  const mountPath = opts.path ?? "/mcp";
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
    if (url.pathname !== mountPath) {
      res.writeHead(404).end("Not found");
      return;
    }

    try {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        // New session: spin up a fresh transport + server instance.
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            transports.set(id, transport!);
          },
        });
        transport.onclose = () => {
          if (transport!.sessionId) transports.delete(transport!.sessionId);
        };
        await build().connect(transport);
      }

      await transport.handleRequest(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) res.writeHead(500);
      res.end(`Internal error: ${message}`);
    }
  });

  await new Promise<void>((resolve) =>
    httpServer.listen(opts.port, opts.host ?? "127.0.0.1", resolve),
  );

  return () =>
    new Promise<void>((resolve) => httpServer.close(() => resolve()));
}
