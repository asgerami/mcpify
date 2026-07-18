import { test } from "node:test";
import assert from "node:assert/strict";
import { filterTools, matchGlob } from "../src/generator/filter.js";
import type { ToolDef } from "../src/types.js";

function tool(over: Partial<ToolDef> & Pick<ToolDef, "name">): ToolDef {
  return {
    description: "",
    method: "GET",
    pathTemplate: "/x",
    params: [],
    security: [],
    ...over,
  };
}

test("matchGlob supports * and ? case-insensitively", () => {
  assert.equal(matchGlob("list_repos", "list_*"), true);
  assert.equal(matchGlob("GET /repos/{id}", "*/repos*"), true);
  assert.equal(matchGlob("Issues", "issues"), true);
  assert.equal(matchGlob("abc", "a?c"), true);
  assert.equal(matchGlob("abcd", "a?c"), false);
});

test("include keeps tools matching name, path, method+path, or tag", () => {
  const tools = [
    tool({ name: "list_repos", pathTemplate: "/repos", tags: ["repos"] }),
    tool({ name: "get_user", method: "GET", pathTemplate: "/users/{id}", tags: ["users"] }),
    tool({ name: "create_issue", method: "POST", pathTemplate: "/repos/{id}/issues" }),
  ];

  assert.deepEqual(
    filterTools(tools, { include: ["list_*"] }).map((t) => t.name),
    ["list_repos"],
  );
  assert.deepEqual(
    filterTools(tools, { include: ["/users*"] }).map((t) => t.name),
    ["get_user"],
  );
  assert.deepEqual(
    filterTools(tools, { include: ["POST *"] }).map((t) => t.name),
    ["create_issue"],
  );
  // Bare `get*` must not match every GET route via METHOD path.
  assert.deepEqual(
    filterTools(tools, { include: ["get_*"] }).map((t) => t.name),
    ["get_user"],
  );
  assert.deepEqual(
    filterTools(tools, { include: ["users"] }).map((t) => t.name),
    ["get_user"],
  );
});

test("exclude drops matches after include", () => {
  const tools = [
    tool({ name: "list_repos", pathTemplate: "/repos" }),
    tool({ name: "delete_repo", pathTemplate: "/repos/{id}" }),
    tool({ name: "get_user", pathTemplate: "/users/{id}" }),
  ];
  const kept = filterTools(tools, {
    include: ["*repo*"],
    exclude: ["delete_*"],
  }).map((t) => t.name);
  assert.deepEqual(kept, ["list_repos"]);
});

test("empty filter returns the original list", () => {
  const tools = [tool({ name: "a" })];
  assert.equal(filterTools(tools, {}), tools);
  assert.equal(filterTools(tools, { include: [], exclude: [] }), tools);
});
