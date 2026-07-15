<p align="center">
  <img src="docs/hero.svg" alt="Wrangl: turn any REST API into an agent-ready MCP server in one command" width="820" />
</p>

<p align="center">
  <a href="https://github.com/asgerami/wrangl/actions/workflows/ci.yml"><img src="https://github.com/asgerami/wrangl/actions/workflows/ci.yml/badge.svg" alt="CI" /></a>
  <img src="https://img.shields.io/badge/tests-passing-brightgreen" alt="tests" />
  <img src="https://img.shields.io/badge/node-%E2%89%A522-blue" alt="node >= 22" />
  <img src="https://img.shields.io/badge/license-MIT-black" alt="MIT" />
</p>

<p align="center"><b>Your AI agent can't use your APIs. Wrangl fixes that in one command.</b></p>

AI agents like Claude and Cursor speak [MCP](https://modelcontextprotocol.io),
but almost every SaaS tool only speaks REST. Wrangl bridges the two. Point it at
any API and it generates a fully working MCP server: every endpoint becomes a
tool the agent can call, with your credentials injected server-side so they are
never exposed to the agent.

No OpenAPI knowledge, no config files, no boilerplate.

<p align="center">
  <img src="docs/dashboard.png" alt="Wrangl dashboard running a generated tool against a live API and showing the JSON response" width="900" />
</p>

## Quick start

Requires **Node 22+**.

```bash
# Point at an API. Wrangl finds the spec, generates the tools, and wires it
# into Claude Desktop. Restart Claude and it can use the API.
npx wrangl install https://petstore3.swagger.io

# No spec handy? Pick a ready-made one from the catalog.
npx wrangl add github        # 1,204 tools
npx wrangl add stripe        # 587 tools
npx wrangl catalog           # see them all

# Prefer a UI? A dashboard to create, test, and monitor servers.
npx wrangl serve             # http://localhost:4000
```

Target Cursor instead with `--client cursor`. Run from source with
`npm install && npm run dev -- <command>`.

## Why Wrangl

- **One command to a working tool.** `wrangl install <api>` discovers the spec,
  generates the tools, and writes the server into your agent client. Done.
- **A catalog of ready-made servers.** `wrangl add github|stripe|openai|twilio`
  so you don't need a spec at all.
- **Auto-discovery.** Point at a bare base URL and Wrangl probes well-known paths
  and even reads the docs page to find the OpenAPI spec.
- **Works with real APIs.** OpenAPI 3.x and Postman collections, tricky
  `style`/`explode` params, relative server URLs, and huge specs (the full
  1,204-tool GitHub API).
- **Auth handled.** Bearer, Basic, API key, and full OAuth2 (PKCE, encrypted
  tokens, auto-refresh). Credentials stay server-side.
- **A real dashboard.** Create servers, run any tool interactively, browse
  request/response logs, and view per-tool analytics.
- **Production-ready.** Docker image, per-server tokens and rate limits, admin
  auth, and a Postgres backend for running multiple replicas.

## How it works

```
Any REST API ->  Ingest  ->  Generate  ->  MCP Runtime  ->  Your agent
 (spec / URL /   (parse +    (endpoints    (proxy calls     (Claude,
  Postman /       normalize)  to tools)     + auth inject)   Cursor...)
  auto-discover)
```

Ingest a spec (or discover it), map every operation to an MCP tool, then run a
server that proxies real calls to the upstream API with auth injected. That is
it, and it scales from a single stdio server up to a hosted multi-tenant control
plane.

## Documentation

The full reference lives in **[docs/GUIDE.md](docs/GUIDE.md)**:

- Every CLI command and flag
- Semantic enrichment, auto-discovery, live spec sync, usage logs
- The hosted control plane, dashboard, and REST API
- Authentication and the OAuth2 flow
- Securing and deploying (Docker, TLS, Postgres for multiple replicas)
- Library usage and project layout

## Development

```bash
npm run typecheck    # tsc --noEmit
npm test             # unit, live-network, and end-to-end MCP tests
npm run build        # emit dist/

WRANGL_SKIP_NETWORK=1 npm test   # skip tests that hit the public internet
```

## License

MIT
