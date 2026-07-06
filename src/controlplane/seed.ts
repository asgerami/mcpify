import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { ServerRegistry } from "./registry.js";

/**
 * Prebuilt server anchors — create a curated set of popular-API servers from a
 * manifest (the launch strategy's "free MCP servers for popular APIs"). Local
 * specs work offline; URL specs are fetched on first seed and then persisted.
 * Seeding is idempotent (matched by name) and fault-tolerant: an unreachable
 * spec is reported and skipped, never blocking the rest.
 */

export interface SeedEntry {
  name: string;
  /** OpenAPI/Postman spec: an http(s) URL or a path relative to the manifest. */
  spec: string;
  baseUrl?: string;
  note?: string;
}

export interface SeedResult {
  created: string[];
  skipped: string[];
  failed: Array<{ name: string; error: string }>;
}

/** Absolute path to the bundled prebuilt manifest (works in dev and from dist). */
export function defaultManifestPath(): string {
  return fileURLToPath(new URL("../../prebuilt/manifest.json", import.meta.url));
}

export function loadManifest(path: string = defaultManifestPath()): SeedEntry[] {
  const data = JSON.parse(readFileSync(path, "utf8")) as
    | SeedEntry[]
    | { servers?: SeedEntry[] };
  const entries = Array.isArray(data) ? data : (data.servers ?? []);
  return entries.filter((e) => e && typeof e.name === "string" && typeof e.spec === "string");
}

/**
 * Create every manifest server not already present in the registry. Existing
 * servers (matched by name) are left untouched.
 */
export async function seedRegistry(
  registry: ServerRegistry,
  manifestPath: string = defaultManifestPath(),
): Promise<SeedResult> {
  const entries = loadManifest(manifestPath);
  const dir = dirname(manifestPath);
  const existing = new Set(registry.list().map((s) => s.name));

  const result: SeedResult = { created: [], skipped: [], failed: [] };
  for (const entry of entries) {
    if (existing.has(entry.name)) {
      result.skipped.push(entry.name);
      continue;
    }
    const spec = /^https?:\/\//i.test(entry.spec) ? entry.spec : resolve(dir, entry.spec);
    try {
      await registry.create({ spec, name: entry.name, baseUrl: entry.baseUrl });
      result.created.push(entry.name);
    } catch (err) {
      result.failed.push({
        name: entry.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}
