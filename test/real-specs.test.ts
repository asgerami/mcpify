import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingest } from "../src/parser/openapi.js";
import { toolInputShape, toolOutputShape } from "../src/generator/schema.js";

/**
 * Robustness sweep against large, real-world specs. The network fetch is
 * decoupled from the assertions: we download the spec to a temp file (with an
 * explicit timeout, skipping if the network is slow/unavailable), then ingest
 * the local copy — so the test exercises ingestion + schema generation
 * deterministically rather than the network. Skipped under WRANGL_SKIP_NETWORK.
 */

const SPECS: Array<{
  name: string;
  url: string;
  ext: string;
  minTools: number;
  // Needed when the spec's own `servers` URL is relative: a downloaded copy has
  // lost the original URL to resolve it against.
  baseUrl?: string;
}> = [
  {
    name: "Petstore (OpenAPI example)",
    url: "https://petstore3.swagger.io/api/v3/openapi.json",
    ext: "json",
    minTools: 10,
    baseUrl: "https://petstore3.swagger.io/api/v3",
  },
  {
    name: "GitHub API (large, complex)",
    url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
    ext: "json",
    minTools: 500,
  },
  {
    // Heavily recursive schemas: dereferencing inlines circular `$ref`s, which
    // must not leak into the generated tools as circular objects.
    name: "Stripe API (recursive schemas)",
    url: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    ext: "json",
    minTools: 500,
  },
];

const skip = process.env.WRANGL_SKIP_NETWORK === "1";

async function download(url: string, ext: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) return null;
    const text = await res.text();
    const dir = await mkdtemp(join(tmpdir(), "wrangl-spec-"));
    const file = join(dir, `spec.${ext}`);
    await writeFile(file, text);
    return file;
  } catch {
    return null; // network slow/unavailable — caller skips
  }
}

for (const spec of SPECS) {
  test(`ingests ${spec.name} without throwing`, { skip, timeout: 120_000 }, async (t) => {
    const file = await download(spec.url, spec.ext);
    if (!file) {
      t.skip(`could not fetch ${spec.name} (network)`);
      return;
    }

    const gen = await ingest(file, spec.baseUrl ? { baseUrl: spec.baseUrl } : {});
    assert.ok(
      gen.tools.length >= spec.minTools,
      `expected ≥ ${spec.minTools} tools, got ${gen.tools.length}`,
    );

    // Generated tools must be plain, finite, JSON-serializable trees: they are
    // persisted to the store and sent over the MCP wire. Recursive specs used
    // to produce circular objects that threw here.
    assert.doesNotThrow(() => JSON.stringify(gen.tools));

    // Tool names must be unique and MCP-safe (letters/digits/underscores).
    const names = new Set<string>();
    for (const tool of gen.tools) {
      assert.match(tool.name, /^[a-z0-9_]+$/, `bad tool name: ${tool.name}`);
      assert.equal(names.has(tool.name), false, `duplicate name: ${tool.name}`);
      names.add(tool.name);
    }

    // Every tool yields a usable input shape and (when present) an output shape
    // that accepts an empty object — building them must never throw.
    for (const tool of gen.tools) {
      assert.equal(typeof toolInputShape(tool), "object");
      const output = toolOutputShape(tool);
      if (output) assert.equal(output.safeParse({}).success, true);
    }
  });
}
