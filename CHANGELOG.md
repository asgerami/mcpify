# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

While the project is pre-1.0, minor versions may include breaking changes.

## [Unreleased]

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

[Unreleased]: https://github.com/asgerami/wrangl/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/asgerami/wrangl/releases/tag/v0.1.0
