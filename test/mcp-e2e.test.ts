import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const SPEC = join(root, "examples", "jsonplaceholder.yaml");

// Boots the real CLI as a subprocess over stdio and drives it as an MCP client,
// exactly like Claude Desktop would.
test(
  "MCP client can list and call generated tools over stdio",
  { skip: process.env.WRANGL_SKIP_NETWORK === "1" },
  async () => {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", join(root, "src", "cli.ts"), "generate", "--spec", SPEC],
    });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(transport);

    try {
      const { tools } = await client.listTools();
      assert.equal(tools.length, 4);
      const getPost = tools.find((t) => t.name === "getpost");
      assert.ok(getPost, "getpost tool should be advertised");
      assert.ok(getPost.inputSchema.properties?.id, "id should be in schema");

      const res = await client.callTool({
        name: "getpost",
        arguments: { id: 1 },
      });
      const content = res.content as Array<{ type: string; text: string }>;
      assert.equal(content[0].type, "text");
      assert.match(content[0].text, /HTTP 200/);
      assert.match(content[0].text, /"id": 1/);
      assert.notEqual(res.isError, true);
    } finally {
      await client.close();
    }
  },
);
