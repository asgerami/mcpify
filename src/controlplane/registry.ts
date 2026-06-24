import { createHash } from "node:crypto";
import { ingest } from "../parser/openapi.js";
import { diffTools, type SpecDiff } from "../generator/diff.js";
import { LogStore, type LogQuery, type LogRow } from "../runtime/logstore.js";
import { loadCredentialsFromEnv, type CredentialStore } from "../runtime/auth.js";
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
}

export class ServerRegistry {
  private entries = new Map<string, ServerEntry>();
  private logStore?: LogStore;

  constructor(opts: RegistryOptions = {}) {
    this.logStore = opts.logStore;
  }

  async create(input: CreateServerInput): Promise<ServerEntry> {
    const generated = await ingest(input.spec, { baseUrl: input.baseUrl });
    const name = input.name ?? generated.name;
    const slug = this.uniqueSlug(name);
    const creds: CredentialStore = {
      ...loadCredentialsFromEnv(generated.securitySchemes),
      ...input.auth,
    };

    const entry: ServerEntry = {
      id: slug,
      name,
      slug,
      specSource: input.spec,
      baseUrl: generated.baseUrl,
      specHash: hashSpec(generated),
      status: "live",
      createdAt: Date.now(),
      generated,
      creds,
    };
    this.entries.set(slug, entry);
    return entry;
  }

  list(): ServerSummary[] {
    return [...this.entries.values()].map(toSummary);
  }

  get(id: string): ServerEntry | undefined {
    return this.entries.get(id);
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
    return diff;
  }

  /** Set or replace a credential for a security scheme (takes effect live). */
  setCredential(id: string, scheme: string, value: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    entry.creds[scheme] = value; // ctx.creds references this object by reference
    return true;
  }

  remove(id: string): boolean {
    return this.entries.delete(id);
  }

  logs(id: string, query: Omit<LogQuery, "server"> = {}): LogRow[] | undefined {
    if (!this.entries.has(id) || !this.logStore) {
      return this.entries.has(id) ? [] : undefined;
    }
    return this.logStore.query({ ...query, server: id });
  }

  /** Sink the runtime should call to persist a tool-call log under a server. */
  recordLog(serverId: string, entry: Parameters<LogStore["record"]>[1]): void {
    this.logStore?.record(serverId, entry);
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
