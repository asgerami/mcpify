import { test } from "node:test";
import assert from "node:assert/strict";
import type Anthropic from "@anthropic-ai/sdk";
import {
  buildBatchPrompt,
  applyEnrichment,
  enrichTools,
  type EnrichmentBatchResult,
} from "../src/generator/enrich.js";
import type { ToolDef } from "../src/types.js";

function tool(overrides: Partial<ToolDef> = {}): ToolDef {
  return {
    name: "post_v1_contacts",
    description: "POST /v1/contacts\n\n(HTTP POST /v1/contacts)",
    method: "POST",
    pathTemplate: "/v1/contacts",
    params: [
      {
        name: "limit",
        sourceName: "limit",
        location: "query",
        required: false,
        schema: { type: "integer" },
      },
    ],
    security: [],
    ...overrides,
  };
}

test("buildBatchPrompt includes method, path, name, and params", () => {
  const prompt = buildBatchPrompt([tool()]);
  assert.match(prompt, /Endpoint 0:/);
  assert.match(prompt, /POST \/v1\/contacts/);
  assert.match(prompt, /current name: post_v1_contacts/);
  assert.match(prompt, /limit \(query\)/);
});

test("applyEnrichment rewrites name, description, and param descriptions", () => {
  const batch = [tool()];
  const result: EnrichmentBatchResult = {
    tools: [
      {
        index: 0,
        name: "Create Contact", // exercises sanitization
        description: "Create a new contact in the CRM.",
        parameters: [{ name: "limit", description: "Max results to return." }],
      },
    ],
  };
  const [enriched] = applyEnrichment(batch, result);
  assert.equal(enriched.name, "create_contact");
  assert.equal(enriched.description, "Create a new contact in the CRM.");
  assert.equal(enriched.params[0].description, "Max results to return.");
  // Structural fields are untouched.
  assert.equal(enriched.method, "POST");
  assert.equal(enriched.pathTemplate, "/v1/contacts");
});

test("applyEnrichment leaves a tool untouched when the model omits it", () => {
  const batch = [tool()];
  const [enriched] = applyEnrichment(batch, { tools: [] });
  assert.equal(enriched.name, "post_v1_contacts");
});

test("enrichTools dedupes colliding names the model produces", async () => {
  const batch = [tool({ name: "a" }), tool({ name: "b" })];
  // Fake client: both tools get rewritten to the same name.
  const fakeClient = {
    messages: {
      parse: async () => ({
        parsed_output: {
          tools: [
            { index: 0, name: "get_thing", description: "First.", parameters: [] },
            { index: 1, name: "get_thing", description: "Second.", parameters: [] },
          ],
        },
      }),
    },
  } as unknown as Anthropic;

  const enriched = await enrichTools(batch, { client: fakeClient });
  assert.deepEqual(
    enriched.map((t) => t.name),
    ["get_thing", "get_thing_2"],
  );
});

test("enrichTools batches and reports progress", async () => {
  const tools = Array.from({ length: 5 }, (_, i) => tool({ name: `t${i}` }));
  let calls = 0;
  const fakeClient = {
    messages: {
      parse: async (params: { messages: { content: string }[] }) => {
        calls++;
        // Echo back enriched entries for whatever indices the prompt described.
        const count = (params.messages[0].content.match(/Endpoint \d+:/g) ?? [])
          .length;
        return {
          parsed_output: {
            tools: Array.from({ length: count }, (_, i) => ({
              index: i,
              name: `enriched_${i}`,
              description: "desc",
              parameters: [],
            })),
          },
        };
      },
    },
  } as unknown as Anthropic;

  const progress: Array<[number, number]> = [];
  const enriched = await enrichTools(tools, {
    client: fakeClient,
    batchSize: 2,
    onBatch: (done, total) => progress.push([done, total]),
  });

  assert.equal(calls, 3); // 2 + 2 + 1
  assert.equal(enriched.length, 5);
  assert.deepEqual(progress, [
    [2, 5],
    [4, 5],
    [5, 5],
  ]);
});

test("enrichTools returns empty for empty input without calling the API", async () => {
  let called = false;
  const fakeClient = {
    messages: { parse: async () => ((called = true), { parsed_output: { tools: [] } }) },
  } as unknown as Anthropic;
  const result = await enrichTools([], { client: fakeClient });
  assert.deepEqual(result, []);
  assert.equal(called, false);
});
