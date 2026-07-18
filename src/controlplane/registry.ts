import { createHash, randomBytes } from "node:crypto";
import { ingest } from "../parser/openapi.js";
import { diffTools, type SpecDiff } from "../generator/diff.js";
import { filterTools, type ToolFilter } from "../generator/filter.js";
import { type LogStore, type LogQuery, type LogRow } from "../runtime/logstore.js";
import { loadCredentialsFromEnv, type CredentialStore } from "../runtime/auth.js";
import { type ServerStore, type ServerRecord } from "./store.js";
import { Vault } from "./vault.js";
import type { GeneratedServer, ToolDef } from "../types.js";

/**
 * In-process registry of generated MCP servers — the heart of the control
 * plane. Each entry is created from a spec, exposes its tools, proxies through
 * the shared runtime, and records usage to a shared SQLite log store. Server
 * records are kept in memory; usage logs persist. (Durable server records are a
 * follow-up; the API is shaped so that swap is internal.)
 */

export interface CreateServerInput {
  /** OpenAPI 3.x spec or Postman collection: URL or file path. */
  spec: string;
  name?: string;
  baseUrl?: string;
  /** Initial credentials, keyed by security-scheme name. */
  auth?: CredentialStore;
  /** Narrow the generated tool list (see `--include` / `--exclude`). */
  include?: string[];
  exclude?: string[];
}

export interface ServerEntry {
  id: string;
  name: string;
  slug: string;
  specSource: string;
  baseUrl: string;
  specHash: string;
  status: "live";
  createdAt: number;
  generated: GeneratedServer;
  creds: CredentialStore;
  /** Bearer token an agent must present to call this server's MCP endpoint. */
  mcpToken: string;
}

/** Public summary of a server (no internals like the full tool list). */
export interface ServerSummary {
  id: string;
  name: string;
  slug: string;
  baseUrl: string;
  toolCount: number;
  status: string;
  createdAt: number;
  specHash: string;
}

export interface RegistryOptions {
  /** Shared usage-log store; when omitted, calls aren't persisted. */
  logStore?: LogStore;
  /** Durable store for server records; when omitted, the registry is in-memory. */
  serverStore?: ServerStore;
  /**
   * Vault for encrypting credentials at rest. With a serverStore present,
   * credentials are persisted (AES-256-GCM) and restored on load; without a
   * vault they stay in memory only and don't survive a restart.
   */
  vault?: Vault;
}

export class ServerRegistry {
  private entries = new Map<string, ServerEntry>();
  private logStore?: LogStore;
  private serverStore?: ServerStore;
  private vault?: Vault;

  constructor(opts: RegistryOptions = {}) {
    this.logStore = opts.logStore;
    this.serverStore = opts.serverStore;
    this.vault = opts.vault;
  }

  async create(input: CreateServerInput): Promise<ServerEntry> {
    const entry = await this.buildEntry({
      spec: input.spec,
      name: input.name,
      baseUrl: input.baseUrl,
      createdAt: Date.now(),
      auth: input.auth,
      toolFilter: { include: input.include, exclude: input.exclude },
    });
    this.entries.set(entry.slug, entry);
    await this.serverStore?.upsert(toRecord(entry));
    // Persist only explicitly-provided credentials (encrypted); env-derived
    // ones are re-derived on boot and need no storage.
    for (const [scheme, value] of Object.entries(input.auth ?? {})) {
      await this.persistCredential(entry.slug, scheme, value);
    }
    return entry;
  }

  /**
   * Rehydrate persisted servers on boot: re-ingest each record's spec and
   * rebuild its entry (credentials re-derived from the environment). Servers
   * whose spec can't be re-ingested are skipped and reported, not dropped from
   * the store, so a transient failure doesn't lose them. Returns load results.
   */
  async load(): Promise<{ restored: number; failed: Array<{ id: string; error: string }> }> {
    if (!this.serverStore) return { restored: 0, failed: [] };
    const failed: Array<{ id: string; error: string }> = [];
    let restored = 0;
    for (const record of await this.serverStore.all()) {
      try {
        const entry = await this.buildEntry({
          spec: record.specSource,
          name: record.name,
          baseUrl: record.baseUrl,
          slug: record.slug,
          createdAt: record.createdAt,
          mcpToken: record.mcpToken,
        });
        await this.restoreCredentials(entry); // decrypt persisted creds over env-derived
        this.entries.set(entry.slug, entry);
        // Backfill a token for servers created before this feature existed.
        if (!record.mcpToken) await this.serverStore?.upsert(toRecord(entry));
        restored++;
      } catch (err) {
        failed.push({ id: record.id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    return { restored, failed };
  }

  /**
   * Build a server entry from a spec; shared by create() and load(). When
   * `slug` is omitted (create), a unique slug is derived from the resolved
   * name; when provided (load), the persisted slug is reused as-is.
   */
  private async buildEntry(input: {
    spec: string;
    name?: string;
    baseUrl?: string;
    slug?: string;
    createdAt: number;
    auth?: CredentialStore;
    mcpToken?: string;
    toolFilter?: ToolFilter;
  }): Promise<ServerEntry> {
    const generated = await ingest(input.spec, { baseUrl: input.baseUrl });
    if (input.toolFilter) {
      generated.tools = filterTools(generated.tools, input.toolFilter);
    }
    const name = input.name ?? generated.name;
    const slug = input.slug ?? this.uniqueSlug(name);
    const creds: CredentialStore = {
      ...loadCredentialsFromEnv(generated.securitySchemes),
      ...input.auth,
    };
    return {
      id: slug,
      name,
      slug,
      specSource: input.spec,
      baseUrl: generated.baseUrl,
      specHash: hashSpec(generated),
      status: "live",
      createdAt: input.createdAt,
      generated,
      creds,
      mcpToken: input.mcpToken ?? generateToken(),
    };
  }

  list(): ServerSummary[] {
    return [...this.entries.values()].map(toSummary);
  }

  get(id: string): ServerEntry | undefined {
    return this.entries.get(id);
  }

  /**
   * Return a server entry, building it from the shared store on a cache miss.
   * This is the read-through path that lets one replica serve a server another
   * replica created: the record lives in Postgres even though this instance's
   * in-memory cache is cold. Returns undefined if no such record exists.
   */
  async resolve(id: string): Promise<ServerEntry | undefined> {
    const cached = this.entries.get(id);
    if (cached) return cached;
    if (!this.serverStore) return undefined;
    const record = await this.serverStore.get(id);
    if (!record) return undefined;
    try {
      const entry = await this.buildEntry({
        spec: record.specSource,
        name: record.name,
        baseUrl: record.baseUrl,
        slug: record.slug,
        createdAt: record.createdAt,
        mcpToken: record.mcpToken,
      });
      await this.restoreCredentials(entry);
      this.entries.set(entry.slug, entry);
      return entry;
    } catch {
      return undefined; // spec no longer ingestable — treat as unavailable
    }
  }

  tools(id: string): ToolDef[] | undefined {
    return this.entries.get(id)?.generated.tools;
  }

  /** Re-ingest the server's spec and swap in the new tools; returns the diff. */
  async regenerate(id: string): Promise<SpecDiff | undefined> {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const next = await ingest(entry.specSource, { baseUrl: entry.baseUrl });
    const diff = diffTools(entry.generated.tools, next.tools);
    entry.generated = next;
    entry.baseUrl = next.baseUrl;
    entry.specHash = hashSpec(next);
    await this.serverStore?.upsert(toRecord(entry));
    return diff;
  }

  /** Set or replace a credential for a security scheme (takes effect live). */
  async setCredential(id: string, scheme: string, value: string): Promise<boolean> {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.creds[scheme] = value; // ctx.creds references this object by reference
    await this.persistCredential(id, scheme, value);
    return true;
  }

  /** Encrypt and persist a credential when a vault + store are configured. */
  private async persistCredential(serverId: string, scheme: string, value: string): Promise<void> {
    if (!this.serverStore || !this.vault) return;
    await this.serverStore.setCredential(serverId, scheme, this.vault.encrypt(value));
  }

  /** Decrypt persisted credentials onto an entry's live credential store. */
  private async restoreCredentials(entry: ServerEntry): Promise<void> {
    if (!this.serverStore || !this.vault) return;
    const creds = await this.serverStore.credentialsFor(entry.slug);
    for (const [scheme, enc] of Object.entries(creds)) {
      try {
        entry.creds[scheme] = this.vault.decrypt(enc);
      } catch {
        // Wrong key or tampered envelope — skip this credential rather than
        // failing the whole boot. The server still loads (likely returning 401
        // until the credential is re-supplied).
      }
    }
  }

  async remove(id: string): Promise<boolean> {
    const existed = this.entries.delete(id);
    if (existed) await this.serverStore?.delete(id);
    return existed;
  }

  async logs(id: string, query: Omit<LogQuery, "server"> = {}): Promise<LogRow[] | undefined> {
    if (!this.entries.has(id) || !this.logStore) {
      return this.entries.has(id) ? [] : undefined;
    }
    return this.logStore.query({ ...query, server: id });
  }

  /** Sink the runtime should call to persist a tool-call log under a server. */
  recordLog(serverId: string, entry: Parameters<LogStore["record"]>[1]): void {
    // Fire-and-forget: never block or fail a tool call on logging.
    this.logStore?.record(serverId, entry)?.catch(() => {});
  }

  private uniqueSlug(name: string): string {
    const base = slugify(name);
    if (!this.entries.has(base)) return base;
    let i = 2;
    while (this.entries.has(`${base}-${i}`)) i++;
    return `${base}-${i}`;
  }
}

export function toSummary(entry: ServerEntry): ServerSummary {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    baseUrl: entry.baseUrl,
    toolCount: entry.generated.tools.length,
    status: entry.status,
    createdAt: entry.createdAt,
    specHash: entry.specHash,
  };
}

function toRecord(entry: ServerEntry): ServerRecord {
  return {
    id: entry.id,
    name: entry.name,
    slug: entry.slug,
    specSource: entry.specSource,
    baseUrl: entry.baseUrl,
    createdAt: entry.createdAt,
    mcpToken: entry.mcpToken,
  };
}

/** A URL-safe random Bearer token for a hosted MCP endpoint. */
function generateToken(): string {
  return randomBytes(24).toString("base64url");
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "server";
}

function hashSpec(gen: GeneratedServer): string {
  const material = JSON.stringify({ baseUrl: gen.baseUrl, tools: gen.tools });
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}
