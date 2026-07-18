import type { ToolDef } from "../types.js";

/**
 * Narrow a generated tool list so agents aren't drowned by huge specs
 * (GitHub ~1.2k tools, Stripe ~600). Patterns match against the tool name,
 * path template, `METHOD path`, or any OpenAPI tag. `*` / `?` glob wildcards
 * are supported; matching is case-insensitive.
 */
export interface ToolFilter {
  /** Keep tools that match ANY of these patterns. When empty, keep all. */
  include?: string[];
  /** Drop tools that match ANY of these patterns (applied after include). */
  exclude?: string[];
}

export function filterTools(tools: ToolDef[], filter: ToolFilter = {}): ToolDef[] {
  const include = normalize(filter.include);
  const exclude = normalize(filter.exclude);
  if (!include.length && !exclude.length) return tools;

  return tools.filter((tool) => {
    if (include.length && !include.some((p) => matchesTool(tool, p))) return false;
    if (exclude.length && exclude.some((p) => matchesTool(tool, p))) return false;
    return true;
  });
}

/** True when the filter would change the tool list. */
export function hasToolFilter(filter: ToolFilter = {}): boolean {
  return normalize(filter.include).length > 0 || normalize(filter.exclude).length > 0;
}

/** Whether a single pattern matches a tool on any of its haystacks. */
function matchesTool(tool: ToolDef, pattern: string): boolean {
  return toolHaystacks(tool, pattern).some((h) => matchGlob(h, pattern));
}

function toolHaystacks(tool: ToolDef, pattern: string): string[] {
  const tags = tool.tags ?? [];
  const haystacks = [tool.name, tool.pathTemplate, ...tags];
  // Only match against `METHOD path` when the pattern looks like one
  // (contains whitespace), so `get*` means tool names — not every GET route.
  if (/\s/.test(pattern)) {
    haystacks.push(`${tool.method} ${tool.pathTemplate}`);
  }
  return haystacks;
}

function normalize(patterns?: string[]): string[] {
  return (patterns ?? []).map((p) => p.trim()).filter(Boolean);
}

/**
 * Case-insensitive glob: `*` = any run of chars, `?` = one char. Everything
 * else is literal (including `/` and `_`).
 */
export function matchGlob(value: string, pattern: string): boolean {
  const v = value.toLowerCase();
  const p = pattern.toLowerCase();
  // Escape regex specials except our glob wildcards, then expand wildcards.
  const re = p
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${re}$`).test(v);
}
