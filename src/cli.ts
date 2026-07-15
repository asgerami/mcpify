#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { Command } from "commander";

/**
 * Load environment variables from .env.local then .env (in the working
 * directory) before anything reads process.env — so `wrangl serve` picks up
 * WRANGL_SECRET_KEY / WRANGL_ADMIN_TOKEN / DATABASE_URL without a launcher flag.
 * Precedence: real shell env > .env.local > .env (nothing already set is
 * overwritten). No dependency; a minimal KEY=value parser.
 */
function loadEnvFiles(): void {
  const loaded: string[] = [];
  for (const file of [".env.local", ".env"]) {
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, "utf8").split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
      if (key in process.env) continue; // shell env / earlier file wins
      let val = line.slice(eq + 1).trim();
      if (/^(".*"|'.*')$/.test(val)) val = val.slice(1, -1);
      process.env[key] = val;
    }
    loaded.push(file);
  }
  if (loaded.length) console.error(`→ loaded env from ${loaded.join(", ")}`);
}
loadEnvFiles();
import { ingest } from "./parser/openapi.js";
import { discoverSpec } from "./parser/discover.js";
import { enrichTools } from "./generator/enrich.js";
import { createMcpServer, createReloadableServer } from "./runtime/server.js";
import { serveStdio, serveHttp } from "./runtime/transport.js";
import { watchSpec } from "./runtime/watch.js";
import { diffTools, formatDiff, hasChanges } from "./generator/diff.js";
import { openLogStore, type LogStore, type LogRow } from "./runtime/logstore.js";
import { ServerRegistry } from "./controlplane/registry.js";
import { openServerStore } from "./controlplane/store.js";
import { Vault } from "./controlplane/vault.js";
import { OAuthManager } from "./controlplane/oauth-manager.js";
import {
  seedRegistry,
  defaultManifestPath,
  loadCatalog,
  findCatalogEntry,
} from "./controlplane/seed.js";
import { buildControlPlane } from "./controlplane/api.js";
import {
  buildServerEntry,
  clientConfigPath,
  clientLabel,
  installServer,
  type ClientName,
} from "./clients.js";
import type { RequestLog } from "./runtime/proxy.js";
import {
  loadCredentialsFromEnv,
  parseAuthFlags,
  type CredentialStore,
} from "./runtime/auth.js";
import type { GeneratedServer } from "./types.js";

/** Default location for the persistent usage-log database. */
const DEFAULT_LOG_DB = join(process.cwd(), ".wrangl", "logs.db");

const program = new Command();

program
  .name("wrangl")
  .description("Turn any REST API into an agent-ready MCP server in minutes.")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate and serve an MCP server from an OpenAPI spec.")
  .option(
    "-s, --spec <source>",
    "OpenAPI 3.x spec or Postman collection: a URL or file path",
  )
  .option(
    "-d, --discover <baseUrl>",
    "Auto-discover the spec by probing well-known paths under a base URL",
  )
  .option(
    "-b, --base-url <url>",
    "Upstream API base URL (overrides the spec's `servers`)",
  )
  .option(
    "-t, --transport <type>",
    "Transport to serve on: stdio | http",
    "stdio",
  )
  .option("-p, --port <number>", "Port for the http transport", "3000")
  .option(
    "-a, --auth <scheme=value...>",
    "Inject a credential for a security scheme (repeatable)",
    collect,
    [],
  )
  .option(
    "-e, --enrich",
    "Run the LLM semantic-enrichment pass (needs ANTHROPIC_API_KEY)",
  )
  .option("-m, --model <id>", "Claude model for enrichment", "claude-opus-4-8")
  .option("--effort <level>", "Enrichment reasoning effort: low | medium | high", "low")
  .option(
    "-l, --log-db [path]",
    `Persist usage logs to a SQLite file (default: ${DEFAULT_LOG_DB})`,
  )
  .option(
    "-w, --watch <seconds>",
    "Re-ingest the spec every N seconds and hot-reload changed tools",
    (v) => Number(v),
  )
  .action(async (options) => {
    try {
      const specSource = await resolveSpec(options);
      // `active` is the live spec; the http build closure and watcher read it.
      let active = await ingest(specSource, { baseUrl: options.baseUrl });
      await maybeEnrich(active, options);
      logSummary(active);

      const creds = resolveCredentials(active, options.auth);
      warnMissingCreds(active, creds);

      const store = await maybeOpenLogStore(options.logDb);
      if (store) console.error(`→ logging tool calls to ${logDbPath(options.logDb)}`);

      const onLog = (e: RequestLog) => {
        console.error(
          `[${e.statusCode ?? "ERR"}] ${e.method} ${e.tool} ${e.latencyMs}ms` +
            (e.error ? ` — ${e.error}` : ""),
        );
        store?.record(active.name, e)?.catch(() => {});
      };

      const startWatch = (onChange: (next: typeof active) => void) => {
        if (!options.watch) return;
        console.error(`→ watching spec every ${options.watch}s for changes`);
        watchSpec(
          specSource,
          {
            intervalMs: options.watch * 1000,
            parse: { baseUrl: options.baseUrl },
            seed: active,
            onError: (err) =>
              console.error(`⚠ spec re-ingest failed: ${errMessage(err)}`),
          },
          onChange,
        );
      };

      if (options.transport === "http") {
        const port = Number(options.port);
        await serveHttp(() => createMcpServer(active, { creds, onLog }), { port });
        console.error(
          `\nMCP server live at http://127.0.0.1:${port}/mcp ` +
            `(Streamable HTTP)\nPress Ctrl+C to stop.`,
        );
        // New HTTP sessions read `active`, so swapping it applies the new spec.
        startWatch((next) => {
          const diff = diffTools(active.tools, next.tools);
          active = next;
          if (hasChanges(diff)) console.error(`\n↻ spec changed:\n${formatDiff(diff)}`);
        });
      } else {
        const reloadable = createReloadableServer(active, { creds, onLog });
        console.error("\nMCP server live on stdio. Connect an agent client.");
        startWatch((next) => {
          const diff = reloadable.reload(next);
          active = next;
          if (hasChanges(diff)) console.error(`\n↻ spec changed:\n${formatDiff(diff)}`);
        });
        await serveStdio(reloadable.server);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("inspect")
  .description("Parse a spec and print the generated tools without serving.")
  .option("-s, --spec <source>", "OpenAPI 3.x spec or Postman collection: URL or file")
  .option("-d, --discover <baseUrl>", "Auto-discover the spec under a base URL")
  .option("-b, --base-url <url>", "Upstream API base URL")
  .option("--json", "Output the full tool definitions as JSON")
  .option(
    "-e, --enrich",
    "Run the LLM semantic-enrichment pass (needs ANTHROPIC_API_KEY)",
  )
  .option("-m, --model <id>", "Claude model for enrichment", "claude-opus-4-8")
  .option("--effort <level>", "Enrichment reasoning effort: low | medium | high", "low")
  .action(async (options) => {
    try {
      const generated = await ingest(await resolveSpec(options), {
        baseUrl: options.baseUrl,
      });
      await maybeEnrich(generated, options);
      if (options.json) {
        console.log(JSON.stringify(generated, null, 2));
        return;
      }
      logSummary(generated);
      for (const tool of generated.tools) {
        const auth = tool.security.length ? ` 🔒 ${tool.security.join(",")}` : "";
        console.log(`\n• ${tool.name}  [${tool.method} ${tool.pathTemplate}]${auth}`);
        const summary = tool.description.split("\n")[0];
        if (summary) console.log(`  ${summary}`);
        for (const p of tool.params) {
          console.log(
            `    - ${p.name} (${p.location}${p.required ? ", required" : ""})`,
          );
        }
        if (tool.body) console.log(`    - body (${tool.body.contentType})`);
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("logs")
  .description("Query persisted tool-call usage logs.")
  .option("-d, --db [path]", `Log database path (default: ${DEFAULT_LOG_DB})`)
  .option("--server <name>", "Filter by server name")
  .option("--tool <name>", "Filter by tool name")
  .option("--status <code>", "Filter by HTTP status code", (v) => Number(v))
  .option("-n, --limit <number>", "Max rows to show", (v) => Number(v), 50)
  .option("-f, --tail", "Follow the log, printing new calls as they arrive")
  .option("--json", "Output rows as JSON")
  .action(async (options) => {
    try {
      const store = await openLogStore(logDbPath(options.db));
      const filter = {
        server: options.server,
        tool: options.tool,
        status: options.status,
        limit: options.limit,
      };

      if (options.tail) {
        await tailLogs(store, filter, options.json);
        return;
      }

      // Newest-first from the store; print oldest-first so the latest is last.
      const rows = (await store.query(filter)).reverse();
      if (options.json) console.log(JSON.stringify(rows, null, 2));
      else for (const row of rows) console.log(formatLogRow(row));
      await store.close();
    } catch (err) {
      fail(err);
    }
  });

const installOptions = (cmd: Command): Command =>
  cmd
    .option("-c, --client <name>", "Agent client to configure: claude | cursor", "claude")
    .option("--config <path>", "Write to a specific MCP config file instead")
    .option("-n, --name <name>", "Name for the server in the client config")
    .option("-b, --base-url <url>", "Upstream API base URL override")
    .option("--print", "Print the config block instead of writing it");

installOptions(
  program
    .command("install")
    .description("Generate an MCP server and wire it into your agent client — one command.")
    .argument("<api>", "Spec URL/file, an API base URL to auto-discover, or a catalog id"),
).action(async (api: string, options) => {
  try {
    await runInstall(api, options);
  } catch (err) {
    fail(err);
  }
});

installOptions(
  program
    .command("add")
    .description("Add a ready-made server from the catalog (see `wrangl catalog`).")
    .argument("<id>", "Catalog id, e.g. github | stripe | petstore"),
).action(async (id: string, options) => {
  try {
    if (!findCatalogEntry(id)) {
      throw new Error(`Unknown catalog id "${id}". Run \`wrangl catalog\` to see them.`);
    }
    await runInstall(id, { ...options, name: options.name ?? id });
  } catch (err) {
    fail(err);
  }
});

program
  .command("catalog")
  .description("List the ready-made servers you can `wrangl add`.")
  .action(() => {
    try {
      const entries = loadCatalog();
      console.log("\nReady-made MCP servers — `wrangl add <id>`\n");
      for (const e of entries) {
        const id = (e.id ?? slug(e.name)).padEnd(16);
        const tools = e.tools ? `${e.tools} tools`.padEnd(11) : "".padEnd(11);
        const auth = (e.auth === "none" ? "no auth" : `auth: ${e.auth ?? "?"}`).padEnd(14);
        console.log(`  ${id}${tools}${auth}${e.note ?? ""}`);
      }
      console.log("\ne.g.  wrangl add petstore    (no key needed — try this one)\n");
    } catch (err) {
      fail(err);
    }
  });

program
  .command("serve")
  .description("Start the control-plane API that hosts multiple MCP servers.")
  .option("-p, --port <number>", "Port to listen on", "4000")
  .option("-H, --host <host>", "Host to bind", "127.0.0.1")
  .option(
    "-l, --log-db [path]",
    `Usage-log SQLite file (default: ${DEFAULT_LOG_DB})`,
  )
  .option(
    "-S, --seed [manifest]",
    "Seed prebuilt server anchors from a manifest (default: bundled)",
  )
  .option(
    "-u, --public-url <url>",
    "Public base URL for OAuth callbacks (env WRANGL_PUBLIC_URL)",
  )
  .option(
    "-a, --admin-token <token>",
    "Require this Bearer token on the management API (env WRANGL_ADMIN_TOKEN)",
  )
  .option(
    "-r, --rate-limit <perMin>",
    "Per-server request/min limit on the hosted MCP endpoint (0 = off)",
    (v) => Number(v),
    0,
  )
  .action(async (options) => {
    try {
      // DB location: --log-db (path or postgres URL) > DATABASE_URL > default file.
      const dbLocation =
        (typeof options.logDb === "string" ? options.logDb : undefined) ??
        process.env.DATABASE_URL ??
        DEFAULT_LOG_DB;
      const vault = Vault.fromEnv();
      const serverStore = await openServerStore(dbLocation);
      const registry = new ServerRegistry({
        logStore: await openLogStore(dbLocation),
        serverStore,
        vault,
      });
      console.error(
        vault
          ? "→ credential encryption enabled (WRANGL_SECRET_KEY)"
          : "⚠ WRANGL_SECRET_KEY not set — credentials stay in memory only " +
              "(set it to persist them encrypted across restarts)",
      );

      const port = Number(options.port);
      const publicBase = (options.publicUrl ?? process.env.WRANGL_PUBLIC_URL ??
        `http://${options.host}:${port}`).replace(/\/+$/, "");
      const adminToken = options.adminToken ?? process.env.WRANGL_ADMIN_TOKEN;

      // OAuth needs a vault to encrypt tokens; enabled only when the key is set.
      const oauth = vault
        ? new OAuthManager({
            registry,
            store: serverStore,
            vault,
            callbackUrl: `${publicBase}/oauth/callback`,
          })
        : undefined;
      console.error(
        oauth
          ? "→ OAuth2 authorization-code flow enabled"
          : "⚠ OAuth2 disabled (needs WRANGL_SECRET_KEY)",
      );

      // Warn loudly if the management API is exposed without an admin token.
      const localOnly = ["127.0.0.1", "localhost", "::1"].includes(options.host);
      if (adminToken) console.error("→ management API requires an admin token");
      else if (!localOnly) {
        console.error(
          "⚠ management API is UNAUTHENTICATED and bound to a non-local host. " +
            "Set --admin-token / WRANGL_ADMIN_TOKEN before exposing it.",
        );
      }
      if (options.rateLimit > 0) {
        console.error(`→ rate limit: ${options.rateLimit} req/min per server`);
      }

      const app = buildControlPlane(registry, {
        oauth,
        adminToken,
        rateLimitPerMin: options.rateLimit,
      });

      // Graceful shutdown so in-flight requests finish and the DB closes.
      const shutdown = async () => {
        console.error("\nshutting down…");
        await app.close().catch(() => {});
        process.exit(0);
      };
      process.once("SIGTERM", shutdown);
      process.once("SIGINT", shutdown);

      await app.listen({ port, host: options.host });
      console.error(
        `\nWrangl control plane on http://${options.host}:${port}` +
          (publicBase !== `http://${options.host}:${port}` ? ` (public: ${publicBase})` : "") +
          `\n  dashboard at /   ·   hosted MCP at /servers/<id>/mcp (Bearer token)\n` +
          `Persisting servers + logs to ${dbLocation}. Press Ctrl+C to stop.`,
      );

      // Rehydrate servers, restore OAuth tokens, and seed anchors in the
      // background so the dashboard is up instantly — restoring a spec from a
      // slow URL shouldn't block startup. Servers appear as they load (a
      // request for one that isn't loaded yet is resolved on demand anyway).
      void (async () => {
        const { restored, failed } = await registry.load();
        if (restored) console.error(`→ restored ${restored} server(s) from ${dbLocation}`);
        for (const f of failed) console.error(`⚠ could not restore "${f.id}": ${f.error}`);
        if (oauth) await oauth.restoreAll();

        if (options.seed) {
          const manifest = typeof options.seed === "string" ? options.seed : defaultManifestPath();
          console.error(`→ seeding prebuilt servers from ${manifest}…`);
          const seed = await seedRegistry(registry, manifest);
          if (seed.created.length) console.error(`→ seeded: ${seed.created.join(", ")}`);
          for (const f of seed.failed) console.error(`  ⚠ ${f.name}: ${f.error}`);
        }
      })().catch((err) => console.error(`⚠ startup restore failed: ${errMessage(err)}`));
    } catch (err) {
      fail(err);
    }
  });

program.parseAsync();

// ---- helpers ----

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

/** URL-safe lowercase name for a config key. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "api";
}

/** Shared by `install` and `add`: resolve → generate → write the client config. */
async function runInstall(
  api: string,
  options: {
    client?: string;
    config?: string;
    name?: string;
    baseUrl?: string;
    print?: boolean;
  },
): Promise<void> {
  const spec = await resolveApiTarget(api);
  console.error(`→ reading ${spec}…`);
  const generated = await ingest(spec, { baseUrl: options.baseUrl });
  const name = slug(options.name ?? generated.name);
  const entry = buildServerEntry(spec, options.baseUrl);
  console.error(`→ generated ${generated.tools.length} tools from ${generated.name}`);

  if (options.print) {
    console.log(JSON.stringify({ mcpServers: { [name]: entry } }, null, 2));
    return;
  }

  const client = (options.client ?? "claude") as ClientName;
  const path = options.config ?? clientConfigPath(client);
  const result = installServer(path, name, entry);
  const target = options.config ? "your client" : clientLabel(client);

  // Nudge the user if the API needs a credential before it will actually work.
  const schemes = Object.keys(generated.securitySchemes);
  const authHint = schemes.length
    ? `\n\nThis API needs auth (${schemes.join(", ")}). Set it with an env var, e.g.` +
      `\n  export WRANGL_BEARER_TOKEN=...    # or WRANGL_API_KEY / WRANGL_AUTH_<SCHEME>`
    : "";

  console.error(
    `\n✓ ${result.replaced ? "Updated" : "Added"} "${name}" in ${target}` +
      `\n  ${result.path}` +
      (result.backup ? `\n  (backup: ${result.backup})` : "") +
      authHint +
      `\n\nRestart ${target} — ${generated.tools.length} tools from ${generated.name} are ready.`,
  );
}

/**
 * Resolve what the user pointed `install`/`add` at: a catalog id, a bare API
 * base URL (auto-discover its spec), or a spec URL/file used as-is.
 */
async function resolveApiTarget(api: string): Promise<string> {
  // A catalog id — no URL needed.
  const fromCatalog = findCatalogEntry(api);
  if (fromCatalog) {
    console.error(`→ ${fromCatalog.name} (catalog)`);
    return fromCatalog.spec;
  }

  // A bare base URL (no spec file extension) — go find the spec.
  if (/^https?:\/\//i.test(api) && !/\.(json|ya?ml)(\?|#|$)/i.test(api)) {
    console.error(`→ discovering spec under ${api}…`);
    const found = await discoverSpec(api);
    if (found) {
      console.error(`→ found spec at ${found.specUrl}`);
      return found.specUrl;
    }
    throw new Error(
      `No OpenAPI spec found under ${api}. Pass the spec URL directly.`,
    );
  }
  return api;
}

/**
 * Resolve the spec source from --spec, or auto-discover it from --discover.
 * Exactly one must be provided.
 */
async function resolveSpec(options: { spec?: string; discover?: string }): Promise<string> {
  if (options.spec) return options.spec;
  if (options.discover) {
    console.error(`→ discovering spec under ${options.discover}…`);
    const found = await discoverSpec(options.discover);
    if (!found) {
      throw new Error(
        `No OpenAPI/Swagger spec found under ${options.discover}. ` +
          `Pass --spec with the exact spec URL instead.`,
      );
    }
    console.error(`→ found spec at ${found.specUrl}`);
    return found.specUrl;
  }
  throw new Error("Provide --spec <url|file> or --discover <baseUrl>.");
}

/** Resolve the log DB path from a flag value (`true` → default path). */
function logDbPath(flag: unknown): string {
  return typeof flag === "string" ? flag : DEFAULT_LOG_DB;
}

/** Open a log store when --log-db was passed; otherwise return undefined. */
async function maybeOpenLogStore(flag: unknown): Promise<LogStore | undefined> {
  return flag ? openLogStore(logDbPath(flag)) : undefined;
}

function formatLogRow(row: LogRow): string {
  const ts = new Date(row.timestamp).toISOString();
  const status = row.error ? "ERR" : (row.status_code ?? "?");
  const tail = row.error ? ` — ${row.error}` : "";
  return `${ts}  [${status}] ${row.method} ${row.tool} (${row.server}) ${row.latency_ms}ms${tail}`;
}

/** Poll the store for new rows and print them until interrupted. */
async function tailLogs(
  store: LogStore,
  filter: { server?: string; tool?: string; status?: number },
  asJson?: boolean,
): Promise<void> {
  // Seed from the most recent existing id so we only show new calls.
  const seed = await store.query({ ...filter, limit: 1 });
  let lastId = seed[0]?.id ?? 0;
  console.error("Tailing usage logs — press Ctrl+C to stop.");

  for (;;) {
    const rows = await store.query({ ...filter, afterId: lastId, limit: 500 });
    for (const row of rows) {
      console.log(asJson ? JSON.stringify(row) : formatLogRow(row));
      lastId = row.id;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Run the semantic-enrichment pass when --enrich is set, replacing the tools
 * on `generated` in place. Requires ANTHROPIC_API_KEY in the environment.
 */
async function maybeEnrich(
  generated: GeneratedServer,
  options: { enrich?: boolean; model?: string; effort?: string },
): Promise<void> {
  if (!options.enrich) return;
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      "--enrich needs ANTHROPIC_API_KEY set in the environment.",
    );
  }
  const effort = options.effort as "low" | "medium" | "high" | undefined;
  console.error(
    `\nEnriching ${generated.tools.length} tools with ${options.model}…`,
  );
  generated.tools = await enrichTools(generated.tools, {
    model: options.model,
    effort,
    onBatch: (done, total) => console.error(`  enriched ${done}/${total}`),
  });
}

function resolveCredentials(
  generated: GeneratedServer,
  authFlags: string[],
): CredentialStore {
  // Env-derived creds first, then explicit --auth flags override them.
  return {
    ...loadCredentialsFromEnv(generated.securitySchemes),
    ...parseAuthFlags(authFlags),
  };
}

function logSummary(generated: GeneratedServer): void {
  console.error(`\n${generated.name} v${generated.version}`);
  console.error(`→ upstream: ${generated.baseUrl}`);
  console.error(`→ generated ${generated.tools.length} MCP tools`);
  const schemes = Object.keys(generated.securitySchemes);
  if (schemes.length) console.error(`→ security schemes: ${schemes.join(", ")}`);
}

function warnMissingCreds(
  generated: GeneratedServer,
  creds: CredentialStore,
): void {
  const needed = new Set<string>();
  for (const tool of generated.tools) {
    for (const s of tool.security) if (!creds[s]) needed.add(s);
  }
  if (needed.size > 0) {
    console.error(
      `⚠ no credential provided for: ${[...needed].join(", ")}. ` +
        `Set WRANGL_AUTH_<SCHEME> or pass --auth <scheme>=<value>. ` +
        `Authenticated calls will likely return 401.`,
    );
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fail(err: unknown): never {
  console.error(`\n✗ ${errMessage(err)}`);
  process.exit(1);
}
