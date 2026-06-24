import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../runtime/server.js";
import { formatDiff } from "../generator/diff.js";
import { ServerRegistry, toSummary, type CreateServerInput } from "./registry.js";

/**
 * Control-plane REST API over the {@link ServerRegistry}. Manages the lifecycle
 * of generated MCP servers and hosts each one as a live MCP endpoint at
 * `/servers/:id/mcp` (Streamable HTTP) — the backend the dashboard and CLI talk
 * to, and the URL agents connect to.
 */
export function buildControlPlane(registry: ServerRegistry): FastifyInstance {
  const app = Fastify({ logger: false });

  // Per-server map of MCP session id → transport, for the hosted endpoint.
  const sessionsByServer = new Map<string, Map<string, StreamableHTTPServerTransport>>();

  app.get("/health", async () => ({ status: "ok" }));

  // Create a server from a spec.
  app.post("/servers", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<CreateServerInput>;
    if (!body.spec) {
      return reply.code(400).send({ error: "`spec` is required (URL or file path)." });
    }
    try {
      const entry = await registry.create({
        spec: body.spec,
        name: body.name,
        baseUrl: body.baseUrl,
        auth: body.auth,
      });
      return reply.code(201).send({ ...toSummary(entry), mcpPath: `/servers/${entry.slug}/mcp` });
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.get("/servers", async () => registry.list());

  app.get("/servers/:id", async (request, reply) => {
    const entry = registry.get(idParam(request));
    if (!entry) return notFound(reply);
    return { ...toSummary(entry), mcpPath: `/servers/${entry.slug}/mcp` };
  });

  app.get("/servers/:id/tools", async (request, reply) => {
    const tools = registry.tools(idParam(request));
    if (!tools) return notFound(reply);
    return tools.map((t) => ({
      name: t.name,
      method: t.method,
      path: t.pathTemplate,
      description: t.description.split("\n")[0],
      params: t.params.map((p) => ({ name: p.name, in: p.location, required: p.required })),
      hasBody: !!t.body,
      security: t.security,
    }));
  });

  app.get("/servers/:id/logs", async (request, reply) => {
    const q = request.query as { tool?: string; status?: string; limit?: string };
    const logs = registry.logs(idParam(request), {
      tool: q.tool,
      status: q.status !== undefined ? Number(q.status) : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    if (!logs) return notFound(reply);
    return logs;
  });

  app.post("/servers/:id/regenerate", async (request, reply) => {
    try {
      const diff = await registry.regenerate(idParam(request));
      if (!diff) return notFound(reply);
      return { diff, summary: formatDiff(diff) };
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post("/servers/:id/credentials", async (request, reply) => {
    const body = (request.body ?? {}) as { scheme?: string; value?: string };
    if (!body.scheme || body.value === undefined) {
      return reply.code(400).send({ error: "`scheme` and `value` are required." });
    }
    const ok = registry.setCredential(idParam(request), body.scheme, body.value);
    if (!ok) return notFound(reply);
    return reply.code(204).send();
  });

  app.delete("/servers/:id", async (request, reply) => {
    const ok = registry.remove(idParam(request));
    if (!ok) return notFound(reply);
    sessionsByServer.delete(idParam(request));
    return reply.code(204).send();
  });

  // Hosted MCP endpoint (Streamable HTTP). One McpServer per session, built
  // from the server's current tools — so a regenerate reaches new sessions.
  app.all("/servers/:id/mcp", async (request, reply) => {
    const id = idParam(request);
    const entry = registry.get(id);
    if (!entry) return notFound(reply);

    const sessions = sessionsByServer.get(id) ?? new Map();
    sessionsByServer.set(id, sessions);

    const sessionId = request.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, transport!);
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) sessions.delete(transport!.sessionId);
      };
      const server = createMcpServer(entry.generated, {
        creds: entry.creds,
        onLog: (e) => registry.recordLog(id, e),
      });
      await server.connect(transport);
    }

    // Hand the raw socket to the MCP transport; Fastify must not also respond.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  return app;
}

function idParam(request: FastifyRequest): string {
  return (request.params as { id: string }).id;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "server not found" });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
