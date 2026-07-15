import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { ServerRegistry } from "../src/controlplane/registry.js";
import { buildControlPlane } from "../src/controlplane/api.js";
import { SqliteLogStore } from "../src/runtime/logstore.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");
const skip = process.env.WRANGL_SKIP_NETWORK === "1";

test(
  "hosted MCP endpoint serves tools and proxies a real call",
  { skip, timeout: 30_000 },
  async () => {
    const registry = new ServerRegistry({ logStore: SqliteLogStore.open(":memory:") });
    const app = buildControlPlane(registry);
    await app.listen({ port: 0, host: "127.0.0.1" });
    const { port } = app.server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}`;

    try {
      // Create a server via the REST API.
      const created = await app.inject({ method: "POST", url: "/servers", payload: { spec: SPEC } });
      const { slug, mcpToken } = created.json();
      assert.ok(mcpToken, "creation should return a per-server MCP token");

      // Connect a real MCP client, presenting the per-server Bearer token.
      const transport = new StreamableHTTPClientTransport(
        new URL(`${base}/servers/${slug}/mcp`),
        { requestInit: { headers: { Authorization: `Bearer ${mcpToken}` } } },
      );
      const client = new Client({ name: "cp-test", version: "1" });
      await client.connect(transport);

      const tools = (await client.listTools()).tools.map((t) => t.name).sort();
      assert.deepEqual(tools, ["createpost", "getpost", "getuser", "listposts"]);

      const res = await client.callTool({ name: "getpost", arguments: { id: 1 } });
      const text = (res.content as Array<{ text: string }>)[0].text;
      assert.match(text, /HTTP 200/);
      assert.match(text, /"id": 1/);

      await client.close();

      // The proxied call should have been logged under this server.
      const logs = await app.inject({ url: `/servers/${slug}/logs` });
      const rows = logs.json() as Array<{ tool: string; status_code: number }>;
      assert.ok(rows.some((r) => r.tool === "getpost" && r.status_code === 200));
    } finally {
      await app.close();
    }
  },
);
