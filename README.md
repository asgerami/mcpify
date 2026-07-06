# MCPify

[![CI](https://github.com/asgerami/mcpify/actions/workflows/ci.yml/badge.svg)](https://github.com/asgerami/mcpify/actions/workflows/ci.yml)

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

- **Ingestion** (`src/parser`) — loads an **OpenAPI 3.x** spec (URL or file,
  JSON/YAML) or a **Postman collection** (v2.x), normalizes both to canonical
  OpenAPI form, dereferences `$ref`s, and resolves the upstream base URL.
- **Generation** (`src/generator`) — deterministically maps each
  `(path, method)` operation to an MCP tool: input schema from OpenAPI
  parameters + request body, and an **outputSchema** from the success-response
  schema. _(The semantic LLM-enrichment pass that rewrites raw names into
  agent-friendly descriptions slots in here.)_
- **Runtime** (`src/runtime`) — a single dynamic server that loads any generated
  spec and exposes its tools over **stdio** or **Streamable HTTP**. On each tool
  call it builds the upstream request — serializing array/object parameters per
  their OpenAPI `style`/`explode` — injects auth, proxies it, and returns the
  response as text plus validated `structuredContent`.

Tested against large real-world specs (the full GitHub REST API, Petstore) to
keep ingestion and schema generation robust.

## Quick start

Requires **Node 22+** (uses the built-in `node:sqlite`).

```bash
# Install the CLI globally…
npm install -g mcpify
mcpify inspect --spec examples/jsonplaceholder.yaml

# …or run from source
npm install
npm run dev -- inspect  --spec examples/jsonplaceholder.yaml   # see the tools
npm run dev -- generate --spec examples/jsonplaceholder.yaml   # serve over stdio

# Or bring up the control plane + dashboard with popular APIs pre-loaded
mcpify serve --seed          # → http://localhost:4000
```

### CLI

```
mcpify generate --spec <url|file> [options]

  -s, --spec <source>     OpenAPI 3.x spec or Postman collection: a URL or file
  -b, --base-url <url>    Upstream base URL (overrides the spec's `servers`)
  -t, --transport <type>  stdio | http              (default: stdio)
  -p, --port <number>     Port for the http transport (default: 3000)
  -a, --auth <scheme=value>   Inject a credential for a security scheme (repeatable)
  -e, --enrich            Run the LLM semantic-enrichment pass (needs ANTHROPIC_API_KEY)
  -m, --model <id>        Claude model for enrichment (default: claude-opus-4-8)
  --effort <level>        Enrichment reasoning effort: low | medium | high (default: low)
  -l, --log-db [path]     Persist tool-call logs to SQLite (default .mcpify/logs.db)
  -w, --watch <seconds>   Re-ingest the spec every N seconds and hot-reload tools

mcpify inspect --spec <url|file> [--json] [--enrich]
  Parse a spec and print the generated tools without serving.

mcpify serve [options]            # control-plane API + dashboard hosting many servers
  -p, --port <number>     Port to listen on (default 4000)
  -H, --host <host>       Host to bind (default 127.0.0.1)
  -l, --log-db [path]     Usage-log SQLite file (default .mcpify/logs.db)
  -S, --seed [manifest]   Seed prebuilt server anchors (default: bundled)

mcpify logs [options]
  -d, --db [path]         Log database path (default .mcpify/logs.db)
  --server <name>         Filter by server name
  --tool <name>           Filter by tool name
  --status <code>         Filter by HTTP status code
  -n, --limit <number>    Max rows to show (default 50)
  -f, --tail              Follow the log, printing new calls as they arrive
  --json                  Output rows as JSON
```

### Semantic enrichment (LLM pass)

The structural generator maps endpoints to tools deterministically — names come
out raw (`post_v1_contacts`). The optional `--enrich` pass sends those stubs to
Claude and rewrites them into names and descriptions an agent selects correctly
(`create_contact`, with a real description and per-parameter explanations). It
uses **structured outputs** so the model returns validated JSON, processes tools
in batches, and only ever improves a tool — anything the model omits falls
through to the deterministic original.

```bash
export ANTHROPIC_API_KEY=sk-ant-...
mcpify inspect  --spec examples/jsonplaceholder.yaml --enrich
mcpify generate --spec examples/jsonplaceholder.yaml --enrich --model claude-sonnet-4-6
```

Defaults to `claude-opus-4-8`; pass `--model claude-sonnet-4-6` to match the
model named in the product spec. Honors `ANTHROPIC_BASE_URL` for gateways.

### Usage logs

Pass `--log-db` to `generate` to persist every tool call to a SQLite database
(request args + truncated response body, status, latency). Query or follow them
with `mcpify logs` — handy for debugging what an agent actually called.

```bash
# Serve with persistent logging
mcpify generate --spec examples/jsonplaceholder.yaml --log-db

# Browse and follow the logs
mcpify logs --tool get_post --status 200
mcpify logs --tail
```

```
2026-06-24T18:34:06.899Z  [200] GET get_post (JSONPlaceholder) 142ms
2026-06-24T18:34:06.957Z  [401] POST create_post (JSONPlaceholder) 88ms
```

Backed by Node's built-in `node:sqlite` — no external database to run. This is
the same log store the future dashboard reads from.

### Live spec sync

Pass `--watch <seconds>` to `generate` and MCPify re-ingests the spec on that
interval. When the tools change, it diffs them and **hot-reloads the running
server** — adding, removing, and updating tools in place and emitting a
`tools/list_changed` notification, so connected agents pick up the new surface
without reconnecting.

```bash
mcpify generate --spec ./api.yaml --watch 30
```

```
↻ spec changed:
+1 added  ~1 changed  -0 removed
  + get_user_by_id
  ~ list_posts (params)
```

Polling needs no inbound connectivity; a webhook trigger would call the same
reload path. The diff engine and `createReloadableServer` / `watchSpec` are
exported for programmatic use.

### Hosted control plane

`mcpify serve` starts a Fastify REST API that manages **many** generated servers
at once and hosts each as a live MCP endpoint at `/servers/:id/mcp` (Streamable
HTTP). It also serves a **dashboard** at `/` — a single self-contained page (no
build step, no external assets) to create servers, inspect their tools, browse
usage logs, copy MCP URLs, regenerate, and delete:

```bash
mcpify serve --port 4000
# open http://localhost:4000  →  dashboard
```

**Prebuilt anchors:** `mcpify serve --seed` boots with a curated set of
popular-API servers ready to use (from [prebuilt/manifest.json](prebuilt/manifest.json) —
JSONPlaceholder works offline; Petstore/Stripe/GitHub are fetched on first
seed). Seeding is idempotent and skips anything already present, so an
unreachable spec never blocks the rest.

```bash
mcpify serve --port 4000

# Create a server from a spec; agents connect to the returned mcpPath
curl -X POST localhost:4000/servers \
  -H 'content-type: application/json' \
  -d '{"spec":"https://petstore3.swagger.io/api/v3/openapi.json","name":"Petstore"}'
# → { "slug":"petstore", "toolCount":19, "mcpPath":"/servers/petstore/mcp", ... }
```

| Method & path | Purpose |
|---|---|
| `POST /servers` | Create a server from a spec (`{spec, name?, baseUrl?, auth?}`) |
| `GET /servers` | List servers |
| `GET /servers/:id` | Server details |
| `GET /servers/:id/tools` | Generated tools |
| `GET /servers/:id/logs` | Usage logs (`?tool=&status=&limit=`) |
| `POST /servers/:id/regenerate` | Re-ingest the spec and diff the tools |
| `POST /servers/:id/credentials` | Set a credential (`{scheme, value}`) |
| `DELETE /servers/:id` | Remove a server |
| `ALL /servers/:id/mcp` | The hosted MCP endpoint agents connect to |

Server records **persist to SQLite** — on restart, `mcpify serve` rehydrates
each server by re-ingesting its spec, so your servers survive a reboot:

```
→ restored 3 server(s) from .mcpify/logs.db
MCPify control plane on http://127.0.0.1:4000
```

Credentials set via the API are **encrypted at rest** (AES-256-GCM) when
`MCPIFY_SECRET_KEY` is set, and decrypted into memory only at proxy time — so
they survive a restart without ever hitting disk in plaintext:

```bash
export MCPIFY_SECRET_KEY="$(openssl rand -hex 32)"   # 32-byte hex/base64, or a passphrase
mcpify serve
# → credential encryption enabled (MCPIFY_SECRET_KEY)
```

Without the key, credentials stay in memory only (and don't survive a restart).
`ServerRegistry`, `ServerStore`, `Vault`, and `buildControlPlane` are exported
for embedding.

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
  parser/postman.ts     Postman collection → canonical OpenAPI
  generator/tools.ts    Map endpoints → MCP tool definitions
  generator/schema.ts   JSON Schema → Zod input/output shapes
  generator/enrich.ts   LLM semantic-enrichment pass (Claude, structured output)
  generator/diff.ts     Diff two tool sets for live reload
  runtime/auth.ts       Credential resolution + auth injection
  runtime/proxy.ts      Build & execute the upstream HTTP request
  runtime/logstore.ts   SQLite usage-log store (node:sqlite)
  runtime/server.ts     Assemble a live (reloadable) McpServer from a spec
  runtime/watch.ts      Poll a spec and fire on change (live sync)
  runtime/transport.ts  stdio + Streamable HTTP transports
  controlplane/registry.ts  Registry of generated servers (+ rehydrate)
  controlplane/store.ts     Durable server records + creds (SQLite)
  controlplane/vault.ts     AES-256-GCM credential encryption
  controlplane/api.ts       Fastify REST API + hosted MCP endpoints
  controlplane/dashboard.html  Self-contained dashboard page
  controlplane/seed.ts      Prebuilt server anchors (seed a manifest)
prebuilt/                 Manifest + specs for popular-API anchors
.github/workflows/ci.yml  Typecheck + build + test on push/PR
  cli.ts                `mcpify generate` / `inspect` / `logs` / `serve`
examples/               Sample specs to try
test/                   Unit, network, and e2e tests
```

## Roadmap (from the product spec)

This engine is MVP scope. Implemented: OpenAPI **and** Postman ingestion, the
LLM semantic-enrichment pass (`--enrich`), `style`/`explode` parameter
serialization, response `outputSchema` / `structuredContent`, persistent SQLite
usage logs (`--log-db` + `mcpify logs`), live spec sync (`--watch`: re-ingest,
diff, and hot-reload tools without dropping connections), and a control-plane
REST API (`mcpify serve`) that hosts many servers and their MCP endpoints, with
**durable server records** (servers survive a restart), **credential encryption
at rest** (AES-256-GCM via `MCPIFY_SECRET_KEY`), and a **dashboard** served at
`/`. Not yet built here: multi-tenant deployment, OAuth2 authorization-code
flow, and spec auto-discovery. The code is structured so each of these layers on
top of the existing pipeline.
