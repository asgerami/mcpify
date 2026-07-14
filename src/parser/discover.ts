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
  "/openapi",
  // Versioned API roots (Swagger Petstore serves /api/v3/openapi.json).
  "/api/openapi.json",
  "/api/swagger.json",
  "/api/v3/openapi.json",
  "/api/v2/openapi.json",
  "/api/v1/openapi.json",
  "/v3/openapi.json",
  "/v2/openapi.json",
  "/v1/openapi.json",
  "/swagger/v1/swagger.json",
  "/openapi/v3",
  "/.well-known/openapi.json",
  "/docs/openapi.json",
  "/spec/openapi.json",
];

/** Files that commonly *reference* the spec URL (Swagger UI bootstraps). */
const SNIFF_PAGES = ["", "/swagger-initializer.js", "/docs", "/api-docs", "/swagger-ui-init.js"];

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

  // 1) Probe the well-known locations.
  const direct = await firstSpec(
    buildCandidates(baseUrl, opts.paths ?? DEFAULT_SPEC_PATHS),
    timeoutMs,
  );
  if (direct) return { specUrl: direct };

  // 2) Nothing at a standard path — read the docs page and follow the spec URL
  //    it references (Swagger UI and friends bootstrap from one).
  const referenced = await sniffReferencedSpecs(baseUrl, timeoutMs);
  const sniffed = await firstSpec(referenced, timeoutMs);
  return sniffed ? { specUrl: sniffed } : null;
}

/** Resolve to the first URL that serves a spec, or null if none do. */
async function firstSpec(urls: string[], timeoutMs: number): Promise<string | null> {
  if (urls.length === 0) return null;
  try {
    return await Promise.any(
      urls.map(async (url) => {
        if (await looksLikeSpec(url, timeoutMs)) return url;
        throw new Error("not a spec");
      }),
    );
  } catch {
    return null;
  }
}

/**
 * Fetch the docs/landing pages and extract any spec URLs they reference — this
 * is how a Swagger UI page points at its own openapi.json.
 */
async function sniffReferencedSpecs(baseUrl: string, timeoutMs: number): Promise<string[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const found = new Set<string>();

  await Promise.all(
    SNIFF_PAGES.map(async (page) => {
      try {
        const res = await fetch(base + page, { signal: AbortSignal.timeout(timeoutMs) });
        if (!res.ok) return;
        const text = (await res.text()).slice(0, 200_000);
        for (const url of extractSpecUrls(text, base + page)) found.add(url);
      } catch {
        /* page not reachable — ignore */
      }
    }),
  );
  return [...found].slice(0, 12);
}

/** Pull spec-looking URLs out of an HTML/JS page, resolved against its own URL. */
export function extractSpecUrls(text: string, pageUrl: string): string[] {
  const out = new Set<string>();
  // Quoted paths/URLs that look like a spec document.
  const re = /["'`]([^"'`\s]*?(?:openapi|swagger|api-docs)[^"'`\s]*?\.(?:json|ya?ml))["'`]/gi;
  for (const m of text.matchAll(re)) {
    try {
      out.add(new URL(m[1], pageUrl).toString());
    } catch {
      /* not resolvable — skip */
    }
  }
  return [...out];
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
