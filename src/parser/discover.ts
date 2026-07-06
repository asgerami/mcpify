/**
 * Spec auto-discovery — point at an API base URL and find its OpenAPI/Swagger
 * spec by probing the well-known locations most frameworks publish to. Returns
 * the first URL that actually serves a spec document. (The "point at any base
 * URL and infer the spec" feature.)
 */

export interface DiscoverOptions {
  /** Per-probe timeout in ms. */
  timeoutMs?: number;
  /** Override the candidate paths to probe. */
  paths?: string[];
}

export interface DiscoverResult {
  specUrl: string;
}

/** Paths commonly used to serve an OpenAPI/Swagger document. */
export const DEFAULT_SPEC_PATHS: string[] = [
  "/openapi.json",
  "/openapi.yaml",
  "/openapi.yml",
  "/swagger.json",
  "/swagger.yaml",
  "/v3/api-docs",
  "/api-docs",
  "/api/openapi.json",
  "/api/swagger.json",
  "/swagger/v1/swagger.json",
  "/openapi/v3",
  "/.well-known/openapi.json",
  "/docs/openapi.json",
  "/spec/openapi.json",
];

const DEFAULT_TIMEOUT_MS = 6000;

/**
 * Probe candidate locations under a base URL and return the first that serves a
 * recognizable spec, or null if none do. Probes run concurrently; the earliest
 * that looks like a spec wins.
 */
export async function discoverSpec(
  baseUrl: string,
  opts: DiscoverOptions = {},
): Promise<DiscoverResult | null> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const candidates = buildCandidates(baseUrl, opts.paths ?? DEFAULT_SPEC_PATHS);

  const probes = candidates.map(async (url) => {
    if (await looksLikeSpec(url, timeoutMs)) return url;
    throw new Error("not a spec");
  });

  try {
    // Promise.any resolves with the first probe that finds a spec.
    const specUrl = await Promise.any(probes);
    return { specUrl };
  } catch {
    return null; // every probe failed
  }
}

/** Build the ordered, de-duplicated list of URLs to probe. */
export function buildCandidates(baseUrl: string, paths: string[]): string[] {
  const trimmed = baseUrl.replace(/\/+$/, "");
  const urls = new Set<string>();
  // The base URL might itself point straight at a spec.
  urls.add(trimmed);
  for (const path of paths) {
    urls.add(trimmed + (path.startsWith("/") ? path : `/${path}`));
  }
  return [...urls];
}

/** Fetch a URL and decide whether the body is an OpenAPI/Swagger document. */
async function looksLikeSpec(url: string, timeoutMs: number): Promise<boolean> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return false;
    const text = await res.text();
    return isSpecDocument(text);
  } catch {
    return false;
  }
}

/** Heuristic: does this text look like an OpenAPI/Swagger spec (JSON or YAML)? */
export function isSpecDocument(text: string): boolean {
  const trimmed = text.trimStart();
  if (trimmed.startsWith("{")) {
    try {
      const doc = JSON.parse(text) as Record<string, unknown>;
      return typeof doc.openapi === "string" || typeof doc.swagger === "string";
    } catch {
      return false;
    }
  }
  // YAML: look for a top-level openapi/swagger version key near the top.
  return /^\s*(openapi|swagger)\s*:\s*["']?\d/m.test(trimmed.slice(0, 2000));
}
