import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../runtime/server.js";
import { formatDiff } from "../generator/diff.js";
import { discoverSpec } from "../parser/discover.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import { ServerRegistry, toSummary, type CreateServerInput } from "./registry.js";
import type { OAuthManager, OAuthConfigInput } from "./oauth-manager.js";

/**
 * Control-plane REST API over the {@link ServerRegistry}. Manages the lifecycle
 * of generated MCP servers and hosts each one as a live MCP endpoint at
 * `/servers/:id/mcp` (Streamable HTTP) — the backend the dashboard and CLI talk
 * to, and the URL agents connect to.
 */
export interface ControlPlaneOptions {
  /** Enables the OAuth2 authorization-code endpoints when provided. */
  oauth?: OAuthManager;
}

export function buildControlPlane(
  registry: ServerRegistry,
  opts: ControlPlaneOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const oauth = opts.oauth;

  // Per-server map of MCP session id → transport, for the hosted endpoint.
  const sessionsByServer = new Map<string, Map<string, StreamableHTTPServerTransport>>();

  app.get("/health", async () => ({ status: "ok" }));

  // The dashboard (single self-contained page) drives the API below.
  app.get("/", async (_request, reply) => reply.type("text/html").send(DASHBOARD_HTML));

  // Create a server from a spec, or auto-discover one from a base URL.
  app.post("/servers", async (request, reply) => {
    const body = (request.body ?? {}) as Partial<CreateServerInput> & { discover?: string };
    if (!body.spec && !body.discover) {
      return reply
        .code(400)
        .send({ error: "Provide `spec` (URL or file path) or `discover` (base URL)." });
    }
    try {
      let spec = body.spec;
      if (!spec && body.discover) {
        const found = await discoverSpec(body.discover);
        if (!found) {
          return reply
            .code(400)
            .send({ error: `No spec found under ${body.discover}. Pass \`spec\` directly.` });
        }
        spec = found.specUrl;
      }
      const entry = await registry.create({
        spec: spec!,
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
    // Include the security schemes so the dashboard can render a credentials
    // form. Only names/types are exposed — never stored secret values.
    const securitySchemes = Object.values(entry.generated.securitySchemes).map((s) => ({
      name: s.name,
      type: s.type,
      detail:
        s.type === "apiKey"
          ? `${s.in}:${s.paramName}`
          : s.type === "http"
            ? s.scheme
            : (s.scopes.join(" ") || "authorization_code"),
    }));
    return { ...toSummary(entry), mcpPath: `/servers/${entry.slug}/mcp`, securitySchemes };
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

  // ---- OAuth2 authorization-code flow ----
  // Enabled only when an OAuthManager is provided (which requires a vault).

  app.get("/servers/:id/oauth", async (request, reply) => {
    const id = idParam(request);
    if (!registry.get(id)) return notFound(reply);
    if (!oauth) return reply.send([]);
    return oauth.statuses(id);
  });

  app.post("/servers/:id/oauth/:scheme/config", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!registry.get(id)) return notFound(reply);
    const body = (request.body ?? {}) as Partial<OAuthConfigInput>;
    if (!body.clientId) return reply.code(400).send({ error: "`clientId` is required." });
    try {
      oauth.configure(id, schemeParam(request), body as OAuthConfigInput);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // Redirect the user's browser to the provider's consent screen.
  app.get("/servers/:id/oauth/:scheme/authorize", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!registry.get(id)) return notFound(reply);
    try {
      return reply.redirect(oauth.startAuthorization(id, schemeParam(request)));
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // Provider redirects here with ?code & ?state after the user consents.
  app.get("/oauth/callback", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const q = request.query as { code?: string; state?: string; error?: string };
    if (q.error) return reply.type("text/html").send(callbackPage(`Authorization failed: ${q.error}`));
    if (!q.code || !q.state) {
      return reply.code(400).type("text/html").send(callbackPage("Missing code or state."));
    }
    try {
      const { serverId, scheme } = await oauth.handleCallback(q.state, q.code);
      return reply.type("text/html").send(
        callbackPage(`Connected "${scheme}" for ${serverId}. You can close this tab.`),
      );
    } catch (err) {
      return reply.code(400).type("text/html").send(callbackPage(errMessage(err)));
    }
  });

  app.post("/servers/:id/oauth/:scheme/refresh", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!registry.get(id)) return notFound(reply);
    try {
      const ok = await oauth.refresh(id, schemeParam(request));
      return ok ? reply.code(204).send() : reply.code(400).send({ error: "No refresh token." });
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
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
        onUnauthorized: oauth
          ? async (schemes) => {
              // Refresh any of the tool's OAuth schemes; retry if one succeeds.
              const results = await Promise.all(
                schemes.map((s) => oauth.refresh(id, s).catch(() => false)),
              );
              return results.some(Boolean);
            }
          : undefined,
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

function schemeParam(request: FastifyRequest): string {
  return (request.params as { scheme: string }).scheme;
}

function oauthDisabled(reply: FastifyReply) {
  return reply
    .code(501)
    .send({ error: "OAuth is disabled. Start the control plane with MCPIFY_SECRET_KEY set." });
}

/** Minimal HTML page shown to the user after the OAuth redirect. */
function callbackPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>MCPify OAuth</title>
<body style="font:15px system-ui;margin:15% auto;max-width:30rem;text-align:center;color:#1d1d1f">
<h2 style="font-weight:600">MCPify</h2><p>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))}</p></body>`;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "server not found" });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
