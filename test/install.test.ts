import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  installServer,
  clientConfigPath,
  selfCommand,
  buildServerEntry,
} from "../src/clients.js";
import { extractSpecUrls } from "../src/parser/discover.js";

async function dir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "wrangl-install-"));
}

test("installServer creates the config file when none exists", async () => {
  const path = join(await dir(), "nested", "mcp.json");
  const res = installServer(path, "petstore", { command: "node", args: ["cli.js"] });

  assert.equal(res.replaced, false);
  assert.equal(res.backup, undefined);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.mcpServers.petstore, { command: "node", args: ["cli.js"] });
});

test("installServer preserves other servers and backs up the original", async () => {
  const path = join(await dir(), "mcp.json");
  writeFileSync(
    path,
    JSON.stringify({ mcpServers: { other: { command: "x", args: [] } }, unrelated: 1 }),
  );

  const res = installServer(path, "petstore", { command: "node", args: ["cli.js"] });
  assert.equal(res.replaced, false);
  assert.ok(res.backup && existsSync(res.backup), "a backup should be written");

  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.ok(cfg.mcpServers.other, "existing server must be preserved");
  assert.ok(cfg.mcpServers.petstore, "new server must be added");
  assert.equal(cfg.unrelated, 1, "unrelated top-level keys must survive");
});

test("installing the same name twice replaces it", async () => {
  const path = join(await dir(), "mcp.json");
  installServer(path, "api", { command: "node", args: ["v1"] });
  const res = installServer(path, "api", { command: "node", args: ["v2"] });

  assert.equal(res.replaced, true);
  const cfg = JSON.parse(readFileSync(path, "utf8"));
  assert.deepEqual(cfg.mcpServers.api.args, ["v2"]);
});

test("a malformed config is refused rather than clobbered", async () => {
  const path = join(await dir(), "mcp.json");
  writeFileSync(path, "{ not json");
  assert.throws(() => installServer(path, "api", { command: "n", args: [] }), /not valid JSON/);
});

test("selfCommand adapts to running from source vs compiled", () => {
  assert.deepEqual(selfCommand("/a/src/cli.ts"), { command: "npx", args: ["tsx", "/a/src/cli.ts"] });
  assert.deepEqual(selfCommand("/a/dist/cli.js"), { command: "node", args: ["/a/dist/cli.js"] });
});

test("buildServerEntry launches `generate` with the spec", () => {
  const entry = buildServerEntry("https://api.test/openapi.json", "https://api.test");
  assert.ok(entry.args.includes("generate"));
  assert.ok(entry.args.includes("https://api.test/openapi.json"));
  assert.ok(entry.args.includes("--base-url"));
});

test("buildServerEntry forwards include/exclude filter flags", () => {
  const entry = buildServerEntry("https://api.test/openapi.json", {
    include: ["repos*", "issues*"],
    exclude: ["*webhook*"],
  });
  assert.deepEqual(
    entry.args.filter((_, i, a) => a[i - 1] === "--include"),
    ["repos*", "issues*"],
  );
  assert.deepEqual(
    entry.args.filter((_, i, a) => a[i - 1] === "--exclude"),
    ["*webhook*"],
  );
});

test("clientConfigPath points at the right file per client", () => {
  assert.match(clientConfigPath("cursor", "/home/u"), /\.cursor[/\\]mcp\.json$/);
  assert.match(clientConfigPath("claude", "/home/u"), /[Cc]laude/);
});

test("extractSpecUrls finds the spec a docs page references", () => {
  const swaggerInit = `window.ui = SwaggerUIBundle({ url: "https://petstore3.swagger.io/api/v3/openapi.json", dom_id: '#ui' });`;
  assert.deepEqual(extractSpecUrls(swaggerInit, "https://petstore3.swagger.io/swagger-initializer.js"), [
    "https://petstore3.swagger.io/api/v3/openapi.json",
  ]);

  // Relative references resolve against the page URL.
  const html = `<script>const spec = './v1/openapi.yaml';</script>`;
  assert.deepEqual(extractSpecUrls(html, "https://api.test/docs"), [
    "https://api.test/v1/openapi.yaml",
  ]);

  assert.deepEqual(extractSpecUrls("<html>nothing here</html>", "https://api.test/"), []);
});
