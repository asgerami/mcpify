# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

## [0.3.0] - 2026-07-20

### Added

- **More `install`/`add` clients.** `--client` now also accepts `windsurf`,
  `cline`, `zed`, and `vscode`, alongside `claude` and `cursor`. Zed and VS
  Code use their own config shape (`context_servers`/`source: "custom"` and
  `servers`/`type: "stdio"` respectively) — handled automatically per client.
- **Grew the catalog.** `wrangl add` now also has `discord` (242 tools),
  `slack` (174 tools, via APIs.guru's OpenAPI 3.0 conversion — Slack's own
  spec is still Swagger 2.0), `sendgrid` (3 tools; mail-sending API only —
  SendGrid's spec is split into 46 per-resource files with no combined doc),
  and `pagerduty` (465 tools).
- **Proxy resilience.** Transient upstream failures (network errors, or a
  502/503/504/500) are now retried automatically with exponential backoff —
  2 retries by default, configurable via `ProxyContext.maxRetries`. Retries
  are limited to methods with no side effect to duplicate (GET, HEAD,
  OPTIONS, PUT, DELETE); POST/PATCH responses are returned as-is so a lost
  response never risks re-running a write twice.

## [0.2.0] - 2026-07-18

### Changed

- **Package name.** Published as `@asgerami/wrangl` — npm rejected the unscoped
  name `wrangl` as too similar to Cloudflare's `wrangler`. The CLI binary is
  still `wrangl`; install with `npx @asgerami/wrangl …`.

### Added

- **Tool filters.** `--include` / `--exclude` (glob) on `generate`, `inspect`,
  `install`, and `add` match tool name, path, `METHOD path`, or OpenAPI tags.
  The control plane `POST /servers` body accepts `include` / `exclude` arrays
  too. Use this to keep huge catalogs (GitHub, Stripe) agent-usable.
- **OAuth2 client_credentials.** Machine-to-machine grant via
  `POST /servers/:id/oauth/:scheme/client-credentials`, with a dashboard button.
  Specs that only advertise `clientCredentials` no longer require an
  authorization URL.
- **OpenID Connect.** `openIdConnect` security schemes are ingested; discovery
  documents supply authorize/token endpoints for the OAuth manager.
- **CI.** Postgres job on every PR; nightly workflow runs live-network tests and
  Postgres. Tag `v*` publishes to npm (`NPM_TOKEN` secret) with pack-content
  checks.

### Changed

- README documents a from-source install path alongside `npx`.

## [0.1.0] - 2026-07-15

First public release. Wrangl turns any REST API into an agent-ready MCP server.

### Added

- **Ingestion.** OpenAPI 3.x, Swagger 2.0, and Postman collections, from a URL
  or a local path. Auto-discovery probes well-known spec paths from a bare base
  URL and reads the docs page to find a referenced spec. Relative server URLs
  resolve against the spec source.
- **Generation.** Every operation becomes an MCP tool, with a JSON Schema to Zod
  converter, full parameter serialization (`style`/`explode`, `deepObject`,
  space and pipe delimited arrays), response output schemas, and safe handling
  of recursive schemas.
- **Runtime.** stdio and Streamable HTTP transports, an upstream proxy that
  injects credentials server-side (Bearer, Basic, API key, OAuth2), a reloadable
  server with live spec sync (`--watch`), and a SQLite usage-log store.
- **Semantic enrichment.** Optional LLM pass that improves tool names and
  descriptions.
- **Control plane.** A Fastify REST API with hosted MCP endpoints, an in-process
  server registry, durable server records (SQLite or Postgres), an AES-256-GCM
  credential vault, and the full OAuth2 authorization-code flow (PKCE, encrypted
  tokens, auto-refresh).
- **Dashboard.** A self-contained UI to create servers, run any tool
  interactively, browse request/response logs, view per-server analytics, and
  manage credentials.
- **CLI.** `generate`, `serve`, `logs`, `install` (one command from an API to a
  wired-up agent client), `add`, and `catalog`. Auto-loads `.env.local` / `.env`.
- **Catalog.** A prebuilt manifest of ready-made servers: Petstore,
  JSONPlaceholder, GitHub (1,204 tools), Stripe (587), OpenAI (242), Twilio (197).
- **Deployment.** Docker image and Compose files, Caddy TLS, admin token,
  per-server tokens and rate limits, and a Postgres backend for multiple replicas.

[Unreleased]: https://github.com/asgerami/wrangl/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/asgerami/wrangl/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/asgerami/wrangl/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/asgerami/wrangl/releases/tag/v0.1.0
