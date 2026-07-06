/**
 * MCPify — turn any REST API into an agent-ready MCP server.
 *
 * Public programmatic API. The pipeline is:
 *   ingest(spec) → GeneratedServer → createMcpServer() → serve over a transport
 */
export { ingest, type ParseOptions } from "./parser/openapi.js";
export { buildTools } from "./generator/tools.js";
export {
  enrichTools,
  buildBatchPrompt,
  applyEnrichment,
  type EnrichOptions,
  type EnrichmentBatchResult,
} from "./generator/enrich.js";
export { toolInputShape, jsonSchemaToZod } from "./generator/schema.js";
export {
  diffTools,
  hasChanges,
  formatDiff,
  type SpecDiff,
  type ToolChange,
} from "./generator/diff.js";
export {
  createMcpServer,
  createReloadableServer,
  type RuntimeOptions,
  type ReloadableServer,
} from "./runtime/server.js";
export { watchSpec, type WatchHandle, type WatchOptions } from "./runtime/watch.js";
export {
  ServerRegistry,
  toSummary,
  type ServerEntry,
  type ServerSummary,
  type CreateServerInput,
  type RegistryOptions,
} from "./controlplane/registry.js";
export { ServerStore, type ServerRecord } from "./controlplane/store.js";
export { Vault } from "./controlplane/vault.js";
export { buildControlPlane } from "./controlplane/api.js";
export {
  seedRegistry,
  loadManifest,
  defaultManifestPath,
  type SeedEntry,
  type SeedResult,
} from "./controlplane/seed.js";
export { executeTool, type ProxyContext, type RequestLog } from "./runtime/proxy.js";
export {
  loadCredentialsFromEnv,
  parseAuthFlags,
  buildAuthInjection,
  type CredentialStore,
} from "./runtime/auth.js";
export { serveStdio, serveHttp } from "./runtime/transport.js";
export {
  LogStore,
  type LogRow,
  type LogQuery,
} from "./runtime/logstore.js";
export * from "./types.js";
