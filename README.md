# MCPify

**Turn any REST API into an agent-ready MCP server in minutes.**

Paste an OpenAPI 3.x spec, get a hosted [Model Context Protocol](https://modelcontextprotocol.io)
server that any AI agent (Claude, etc.) can call as native tools. MCPify parses
the spec, maps every endpoint to an MCP tool, and runs a server that proxies
real API calls — injecting your credentials server-side so they're never exposed
to the agent.

This repository contains the **core engine**: the ingestion → generation →
runtime pipeline, exposed as a CLI and a library. It's the foundation the hosted
product and dashboard build on.

## How it works

```
OpenAPI spec ──▶ Ingestion ──▶ Generation ──▶ MCP Runtime ──▶ Agent
 (URL/file)      (parse +      (endpoints →    (proxy calls    (Claude,
                 normalize)     MCP tools)      + auth inject)   LangChain…)
```

- **Ingestion** (`src/parser`) — loads a spec from a URL or file (JSON/YAML),
  validates and fully dereferences `$ref`s, resolves the upstream base URL.
- **Generation** (`src/generator`) — deterministically maps each
  `(path, method)` operation to an MCP tool, deriving the input schema from
  OpenAPI parameters + request body. _(The semantic LLM-enrichment pass that
  rewrites raw names into agent-friendly descriptions slots in here.)_
- **Runtime** (`src/runtime`) — a single dynamic server that loads any generated
  spec and exposes its tools over **stdio** or **Streamable HTTP**. On each tool
  call it builds the upstream request, injects auth, proxies it, and returns the
  normalized response.

## Quick start

```bash
npm install
npm run build        # or use `npm run dev -- …` to run from source via tsx

# Inspect what tools a spec produces (no server)
npm run dev -- inspect --spec examples/jsonplaceholder.yaml

# Serve it as an MCP server over stdio
npm run dev -- generate --spec examples/jsonplaceholder.yaml
```

### CLI

```
mcpify generate --spec <url|file> [options]

  -s, --spec <source>     OpenAPI 3.x spec: a URL or path to a JSON/YAML file
  -b, --base-url <url>    Upstream base URL (overrides the spec's `servers`)
  -t, --transport <type>  stdio | http              (default: stdio)
  -p, --port <number>     Port for the http transport (default: 3000)
  -a, --auth <scheme=value>   Inject a credential for a security scheme (repeatable)

mcpify inspect --spec <url|file> [--json]
  Parse a spec and print the generated tools without serving.
```

### Connecting from Claude Desktop

Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "jsonplaceholder": {
      "command": "npx",
      "args": ["tsx", "/abs/path/to/mcpify/src/cli.ts",
               "generate", "--spec", "/abs/path/to/examples/jsonplaceholder.yaml"]
    }
  }
}
```

Restart Claude Desktop and the API's endpoints appear as callable tools.

## Authentication

Credentials are resolved per security scheme and injected at request time —
agents never see them. Supported schemes: **Bearer**, **Basic**, and
**API Key** (header / query / cookie).

Provide credentials by environment variable (preferred) or `--auth` flag:

```bash
# Per-scheme env var: MCPIFY_AUTH_<SCHEME_NAME>  (scheme name upper-cased)
export MCPIFY_AUTH_BEARERAUTH="my-token"

# …or generic fallbacks
export MCPIFY_BEARER_TOKEN="my-token"
export MCPIFY_API_KEY="my-key"

# …or explicitly on the command line (scheme name must match the spec)
mcpify generate --spec api.yaml --auth bearerAuth=my-token
```

For Basic auth, pass the value as `user:password`.

## Library usage

```ts
import { ingest, createMcpServer, serveStdio } from "mcpify";

const generated = await ingest("https://api.example.com/openapi.json", {
  baseUrl: "https://api.example.com",
});

const server = createMcpServer(generated, {
  creds: { bearerAuth: process.env.TOKEN! },
  onLog: (e) => console.error(e),
});

await serveStdio(server);
```

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit + live-network + end-to-end MCP tests
npm run build        # emit dist/

# Skip the tests that hit the public JSONPlaceholder API:
MCPIFY_SKIP_NETWORK=1 npm test
```

The test suite covers the parser, the schema mapping, live proxied GET/POST
calls, and a full end-to-end run where an MCP client drives the CLI as a
subprocess over stdio.

## Project layout

```
src/
  parser/openapi.ts     Ingestion: load, validate, normalize a spec
  generator/tools.ts    Map endpoints → MCP tool definitions
  generator/schema.ts   JSON Schema → Zod input shapes
  runtime/auth.ts       Credential resolution + auth injection
  runtime/proxy.ts      Build & execute the upstream HTTP request
  runtime/server.ts     Assemble a live McpServer from a spec
  runtime/transport.ts  stdio + Streamable HTTP transports
  cli.ts                `mcpify generate` / `mcpify inspect`
examples/               Sample specs to try
test/                   Unit, network, and e2e tests
```

## Roadmap (from the product spec)

This engine is MVP scope. Not yet built here: hosted multi-tenant deployment,
the dashboard/control plane, persistent usage logs, OAuth2 authorization-code
flow, the LLM semantic-enrichment pass, spec auto-discovery, and live spec sync.
The code is structured so each of these layers on top of the existing pipeline.
