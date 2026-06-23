import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ingest } from "../src/parser/openapi.js";
import { executeTool } from "../src/runtime/proxy.js";
import { toolInputShape } from "../src/generator/schema.js";
import type { ToolDef } from "../src/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, "..", "examples", "jsonplaceholder.yaml");

function tool(tools: ToolDef[], name: string): ToolDef {
  const t = tools.find((x) => x.name === name);
  assert.ok(t, `expected a tool named "${name}"`);
  return t;
}

test("ingest parses the example spec into tools", async () => {
  const gen = await ingest(SPEC);
  assert.equal(gen.baseUrl, "https://jsonplaceholder.typicode.com");
  assert.equal(gen.tools.length, 4);

  const names = gen.tools.map((t) => t.name).sort();
  assert.deepEqual(names, ["createpost", "getpost", "getuser", "listposts"]);
});

test("path and query params are mapped with correct locations", async () => {
  const gen = await ingest(SPEC);
  const getPost = tool(gen.tools, "getpost");
  assert.equal(getPost.method, "GET");
  const id = getPost.params.find((p) => p.name === "id");
  assert.equal(id?.location, "path");
  assert.equal(id?.required, true);

  const listPosts = tool(gen.tools, "listposts");
  const userId = listPosts.params.find((p) => p.name === "userid");
  assert.equal(userId?.location, "query");
  assert.equal(userId?.required, false);
});

test("request body becomes a `body` input on the tool", async () => {
  const gen = await ingest(SPEC);
  const createPost = tool(gen.tools, "createpost");
  assert.ok(createPost.body);
  assert.equal(createPost.body?.required, true);
  const shape = toolInputShape(createPost);
  assert.ok("body" in shape, "expected a body property in the input shape");
});

test("input shape exposes params as zod properties", async () => {
  const gen = await ingest(SPEC);
  const shape = toolInputShape(tool(gen.tools, "listposts"));
  assert.ok("userid" in shape);
});

// Live network test — proxies a real call to the public JSONPlaceholder API.
test(
  "executeTool proxies a GET with a path param to the upstream API",
  { skip: process.env.MCPIFY_SKIP_NETWORK === "1" },
  async () => {
    const gen = await ingest(SPEC);
    const getPost = tool(gen.tools, "getpost");
    const result = await executeTool(
      getPost,
      { id: 1 },
      { baseUrl: gen.baseUrl, schemes: gen.securitySchemes, creds: {} },
    );
    assert.equal(result.statusCode, 200);
    assert.ok(result.ok);
    const json = JSON.parse(result.body);
    assert.equal(json.id, 1);
    assert.equal(typeof json.title, "string");
  },
);

test(
  "executeTool proxies a POST with a JSON body",
  { skip: process.env.MCPIFY_SKIP_NETWORK === "1" },
  async () => {
    const gen = await ingest(SPEC);
    const createPost = tool(gen.tools, "createpost");
    const result = await executeTool(
      createPost,
      { body: { title: "hi", body: "from mcpify", userId: 7 } },
      { baseUrl: gen.baseUrl, schemes: gen.securitySchemes, creds: {} },
    );
    assert.equal(result.statusCode, 201);
    const json = JSON.parse(result.body);
    assert.equal(json.title, "hi");
    assert.equal(json.userId, 7);
  },
);
