#!/usr/bin/env node
import { Command } from "commander";
import { ingest } from "./parser/openapi.js";
import { enrichTools } from "./generator/enrich.js";
import { createMcpServer } from "./runtime/server.js";
import { serveStdio, serveHttp } from "./runtime/transport.js";
import {
  loadCredentialsFromEnv,
  parseAuthFlags,
  type CredentialStore,
} from "./runtime/auth.js";
import type { GeneratedServer } from "./types.js";

const program = new Command();

program
  .name("mcpify")
  .description("Turn any REST API into an agent-ready MCP server in minutes.")
  .version("0.1.0");

program
  .command("generate")
  .description("Generate and serve an MCP server from an OpenAPI spec.")
  .requiredOption(
    "-s, --spec <source>",
    "OpenAPI 3.x spec: a URL, or a path to a JSON/YAML file",
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
  .action(async (options) => {
    try {
      const generated = await ingest(options.spec, {
        baseUrl: options.baseUrl,
      });
      await maybeEnrich(generated, options);
      logSummary(generated);

      const creds = resolveCredentials(generated, options.auth);
      warnMissingCreds(generated, creds);

      const build = () =>
        createMcpServer(generated, {
          creds,
          // Logs go to stderr so stdout stays clean for the stdio transport.
          onLog: (e) =>
            console.error(
              `[${e.statusCode ?? "ERR"}] ${e.method} ${e.tool} ${e.latencyMs}ms` +
                (e.error ? ` — ${e.error}` : ""),
            ),
        });

      if (options.transport === "http") {
        const port = Number(options.port);
        await serveHttp(build, { port });
        console.error(
          `\nMCP server live at http://127.0.0.1:${port}/mcp ` +
            `(Streamable HTTP)\nPress Ctrl+C to stop.`,
        );
      } else {
        console.error("\nMCP server live on stdio. Connect an agent client.");
        await serveStdio(build());
      }
    } catch (err) {
      fail(err);
    }
  });

program
  .command("inspect")
  .description("Parse a spec and print the generated tools without serving.")
  .requiredOption("-s, --spec <source>", "OpenAPI 3.x spec URL or file path")
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
      const generated = await ingest(options.spec, {
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

program.parseAsync();

// ---- helpers ----

function collect(value: string, previous: string[]): string[] {
  return previous.concat([value]);
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
        `Set MCPIFY_AUTH_<SCHEME> or pass --auth <scheme>=<value>. ` +
        `Authenticated calls will likely return 401.`,
    );
  }
}

function fail(err: unknown): never {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`\n✗ ${message}`);
  process.exit(1);
}
