import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from "fastify";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../runtime/server.js";
import { executeTool } from "../runtime/proxy.js";
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
  /**
   * When set, the management API (everything except the dashboard shell, health,
   * the OAuth callback, and the hosted MCP endpoints) requires
   * `Authorization: Bearer <adminToken>`.
   */
  adminToken?: string;
  /** Per-server request limit per minute on the hosted MCP endpoint (0 = off). */
  rateLimitPerMin?: number;
}

export function buildControlPlane(
  registry: ServerRegistry,
  opts: ControlPlaneOptions = {},
): FastifyInstance {
  const app = Fastify({ logger: false });
  const oauth = opts.oauth;
  const rateLimiter = new RateLimiter(opts.rateLimitPerMin ?? 0);

  // Per-server map of MCP session id → transport, for the hosted endpoint.
  const sessionsByServer = new Map<string, Map<string, StreamableHTTPServerTransport>>();

  // Resolve a server by id, reading through the shared store on a cache miss so
  // this replica can serve servers another replica created. OAuth tokens are
  // (re)injected only when the entry is freshly built, not on every request.
  const resolveServer = async (id: string) => {
    if (registry.get(id)) return registry.get(id);
    const entry = await registry.resolve(id);
    if (entry && oauth) await oauth.restoreServer(id);
    return entry;
  };

  // On a 401, refresh any of the tool's OAuth schemes and signal a retry.
  const oauthRefresher = (id: string) =>
    oauth
      ? async (schemes: string[]) => {
          const results = await Promise.all(
            schemes.map((s) => oauth.refresh(id, s).catch(() => false)),
          );
          return results.some(Boolean);
        }
      : undefined;

  // Gate the management API behind the admin token. Public routes (the dashboard
  // shell, health, the OAuth callback, and the token-gated MCP endpoints) are
  // exempt — see isPublicRoute.
  if (opts.adminToken) {
    app.addHook("onRequest", async (request, reply) => {
      if (isPublicRoute(request.url)) return;
      if (request.headers.authorization !== `Bearer ${opts.adminToken}`) {
        return reply.code(401).send({ error: "Unauthorized: admin token required." });
      }
    });
  }

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
      return reply.code(201).send({
        ...toSummary(entry),
        mcpPath: `/servers/${entry.slug}/mcp`,
        // Returned once here (and on detail) so the operator can hand it to an
        // agent — required as a Bearer token on the hosted MCP endpoint.
        mcpToken: entry.mcpToken,
      });
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.get("/servers", async () => registry.list());

  app.get("/servers/:id", async (request, reply) => {
    const entry = await resolveServer(idParam(request));
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
            : s.type === "openIdConnect"
              ? s.openIdConnectUrl
              : (s.flows.join(",") || s.scopes.join(" ") || "authorization_code"),
      flows: s.type === "oauth2" ? s.flows : s.type === "openIdConnect"
        ? (["authorizationCode", "clientCredentials"] as const)
        : undefined,
    }));
    return {
      ...toSummary(entry),
      mcpPath: `/servers/${entry.slug}/mcp`,
      mcpToken: entry.mcpToken,
      securitySchemes,
      // Scheme names that currently have a credential value (never the values).
      credentialsSet: Object.keys(entry.creds).filter((k) => entry.creds[k]),
    };
  });

  app.get("/servers/:id/tools", async (request, reply) => {
    if (!(await resolveServer(idParam(request)))) return notFound(reply);
    const tools = registry.tools(idParam(request));
    if (!tools) return notFound(reply);
    return tools.map((t) => ({
      name: t.name,
      method: t.method,
      path: t.pathTemplate,
      description: t.description.split("\n")[0],
      params: t.params.map((p) => ({
        name: p.name,
        in: p.location,
        required: p.required,
        type: Array.isArray(p.schema.type) ? p.schema.type[0] : p.schema.type,
        description: p.description,
      })),
      hasBody: !!t.body,
      security: t.security,
    }));
  });

  // Invoke a tool from the dashboard's interactive tester: run it through the
  // same proxy the MCP endpoint uses (auth injected, logged), return the result.
  app.post("/servers/:id/tools/:tool/invoke", async (request, reply) => {
    const id = idParam(request);
    const entry = await resolveServer(id);
    if (!entry) return notFound(reply);
    const toolName = (request.params as { tool: string }).tool;
    const tool = entry.generated.tools.find((t) => t.name === toolName);
    if (!tool) return reply.code(404).send({ error: "tool not found" });

    const args = (request.body ?? {}) as Record<string, unknown>;
    try {
      const result = await executeTool(tool, args, {
        baseUrl: entry.generated.baseUrl,
        schemes: entry.generated.securitySchemes,
        creds: entry.creds,
        onLog: (e) => registry.recordLog(id, e),
        onUnauthorized: oauthRefresher(id),
      });
      return {
        statusCode: result.statusCode,
        ok: result.ok,
        contentType: result.contentType,
        body: result.body,
      };
    } catch (err) {
      // Network/DNS failure reaching the upstream (not an HTTP error status).
      return reply.code(502).send({ error: errMessage(err) });
    }
  });

  app.get("/servers/:id/logs", async (request, reply) => {
    if (!(await resolveServer(idParam(request)))) return notFound(reply);
    const q = request.query as { tool?: string; status?: string; limit?: string };
    const logs = await registry.logs(idParam(request), {
      tool: q.tool,
      status: q.status !== undefined ? Number(q.status) : undefined,
      limit: q.limit !== undefined ? Number(q.limit) : undefined,
    });
    if (!logs) return notFound(reply);
    return logs;
  });

  // Aggregate the usage logs into analytics: totals, error rate, latency
  // percentiles, per-tool breakdown, and a 24h hourly volume series.
  app.get("/servers/:id/stats", async (request, reply) => {
    if (!(await resolveServer(idParam(request)))) return notFound(reply);
    const rows = (await registry.logs(idParam(request), { limit: 5000 })) ?? [];
    const isErr = (r: (typeof rows)[number]) => !!r.error || (r.status_code ?? 0) >= 400;

    const latencies = rows.map((r) => r.latency_ms).sort((a, b) => a - b);
    const errors = rows.filter(isErr).length;

    // Per-tool: call count, error count, p95 latency.
    const byTool = new Map<string, number[]>();
    const toolErrors = new Map<string, number>();
    for (const r of rows) {
      (byTool.get(r.tool) ?? byTool.set(r.tool, []).get(r.tool)!).push(r.latency_ms);
      if (isErr(r)) toolErrors.set(r.tool, (toolErrors.get(r.tool) ?? 0) + 1);
    }
    const perTool = [...byTool.entries()]
      .map(([tool, lat]) => ({
        tool,
        calls: lat.length,
        errors: toolErrors.get(tool) ?? 0,
        p95: percentile(lat.slice().sort((a, b) => a - b), 0.95),
      }))
      .sort((a, b) => b.calls - a.calls);

    // 24 hourly buckets ending now (oldest first).
    const now = Date.now();
    const hourMs = 3_600_000;
    const hourly = Array.from({ length: 24 }, (_, i) => ({
      t: now - (23 - i) * hourMs,
      count: 0,
    }));
    for (const r of rows) {
      const idx = 23 - Math.floor((now - r.timestamp) / hourMs);
      if (idx >= 0 && idx < 24) hourly[idx].count++;
    }

    return {
      total: rows.length,
      errors,
      errorRate: rows.length ? errors / rows.length : 0,
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      perTool,
      hourly,
    };
  });

  app.post("/servers/:id/regenerate", async (request, reply) => {
    try {
      if (!(await resolveServer(idParam(request)))) return notFound(reply);
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
    if (!(await resolveServer(idParam(request)))) return notFound(reply);
    await registry.setCredential(idParam(request), body.scheme, body.value);
    return reply.code(204).send();
  });

  app.delete("/servers/:id", async (request, reply) => {
    if (!(await resolveServer(idParam(request)))) return notFound(reply);
    const ok = await registry.remove(idParam(request));
    if (!ok) return notFound(reply);
    sessionsByServer.delete(idParam(request));
    return reply.code(204).send();
  });

  // ---- OAuth2 authorization-code flow ----
  // Enabled only when an OAuthManager is provided (which requires a vault).

  app.get("/servers/:id/oauth", async (request, reply) => {
    const id = idParam(request);
    if (!(await resolveServer(id))) return notFound(reply);
    if (!oauth) return reply.send([]);
    return await oauth.statuses(id);
  });

  app.post("/servers/:id/oauth/:scheme/config", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!(await resolveServer(id))) return notFound(reply);
    const body = (request.body ?? {}) as Partial<OAuthConfigInput>;
    if (!body.clientId) return reply.code(400).send({ error: "`clientId` is required." });
    try {
      await oauth.configure(id, schemeParam(request), body as OAuthConfigInput);
      return reply.code(204).send();
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  // Return the provider consent URL as JSON (so it stays behind admin auth —
  // a browser redirect can't carry the Authorization header). The dashboard
  // fetches this, then opens the returned URL.
  app.get("/servers/:id/oauth/:scheme/authorize", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!(await resolveServer(id))) return notFound(reply);
    try {
      return { url: await oauth.startAuthorization(id, schemeParam(request)) };
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

  // Machine-to-machine: exchange client_id/secret for an access token.
  app.post("/servers/:id/oauth/:scheme/client-credentials", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!(await resolveServer(id))) return notFound(reply);
    try {
      const tokens = await oauth.clientCredentials(id, schemeParam(request));
      return {
        connected: true,
        expiresAt: tokens.expiresAt,
      };
    } catch (err) {
      return reply.code(400).send({ error: errMessage(err) });
    }
  });

  app.post("/servers/:id/oauth/:scheme/refresh", async (request, reply) => {
    if (!oauth) return oauthDisabled(reply);
    const id = idParam(request);
    if (!(await resolveServer(id))) return notFound(reply);
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
    const entry = await resolveServer(id);
    if (!entry) return notFound(reply);

    // Per-server Bearer token: this endpoint proxies calls using stored
    // credentials, so it must not be open to anyone who knows the URL.
    if (request.headers.authorization !== `Bearer ${entry.mcpToken}`) {
      return reply.code(401).send({ error: "Unauthorized: server MCP token required." });
    }
    // Per-server rate limit to bound cost/abuse on the public proxy.
    if (!rateLimiter.allow(id)) {
      return reply.code(429).send({ error: "Rate limit exceeded for this server." });
    }

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
        onUnauthorized: oauthRefresher(id),
      });
      await server.connect(transport);
    }

    // Hand the raw socket to the MCP transport; Fastify must not also respond.
    reply.hijack();
    await transport.handleRequest(request.raw, reply.raw, request.body);
  });

  return app;
}

/** Routes exempt from admin auth (shell, health, OAuth callback, MCP endpoints). */
function isPublicRoute(url: string): boolean {
  const path = url.split("?")[0];
  if (path === "/" || path === "/health" || path === "/oauth/callback") return true;
  // Hosted MCP endpoints have their own per-server token check.
  return /^\/servers\/[^/]+\/mcp$/.test(path);
}

/** Fixed-window (per-minute) per-key request limiter, in memory. */
class RateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();
  constructor(private readonly perMin: number) {}

  allow(key: string): boolean {
    if (this.perMin <= 0) return true; // disabled
    const now = Date.now();
    const rec = this.hits.get(key);
    if (!rec || now - rec.windowStart >= 60_000) {
      this.hits.set(key, { count: 1, windowStart: now });
      return true;
    }
    if (rec.count >= this.perMin) return false;
    rec.count++;
    return true;
  }
}

/** Nearest-rank percentile of an ascending-sorted array; 0 for empty. */
function percentile(sortedAsc: number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.floor(q * (sortedAsc.length - 1)));
  return sortedAsc[idx];
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
    .send({ error: "OAuth is disabled. Start the control plane with WRANGL_SECRET_KEY set." });
}

/** Minimal HTML page shown to the user after the OAuth redirect. */
function callbackPage(message: string): string {
  return `<!doctype html><meta charset="utf-8"><title>Wrangl OAuth</title>
<body style="font:15px system-ui;margin:15% auto;max-width:30rem;text-align:center;color:#1d1d1f">
<h2 style="font-weight:600">Wrangl</h2><p>${message.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!))}</p></body>`;
}

function notFound(reply: FastifyReply) {
  return reply.code(404).send({ error: "server not found" });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
