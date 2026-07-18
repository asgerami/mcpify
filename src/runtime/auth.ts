import type { SecurityScheme } from "../types.js";

/**
 * Resolved credential values, keyed by security-scheme name. In the hosted
 * product these come from the encrypted Auth Vault; in the CLI they come from
 * environment variables or `--auth` flags. The runtime never exposes them to
 * the agent — it injects them into the upstream request at proxy time.
 */
export type CredentialStore = Record<string, string>;

export interface AuthInjection {
  headers: Record<string, string>;
  query: Record<string, string>;
}

/**
 * Given the schemes an operation requires and the available credentials,
 * produce the headers/query params to inject. Uses the first scheme that has
 * a credential available (OpenAPI security is OR across requirements).
 */
export function buildAuthInjection(
  requiredSchemes: string[],
  schemes: Record<string, SecurityScheme>,
  creds: CredentialStore,
): AuthInjection {
  const injection: AuthInjection = { headers: {}, query: {} };

  for (const schemeName of requiredSchemes) {
    const scheme = schemes[schemeName];
    const value = creds[schemeName];
    if (!scheme || !value) continue;

    if (scheme.type === "http" && scheme.scheme === "bearer") {
      injection.headers["Authorization"] = `Bearer ${value}`;
      return injection;
    }
    if (scheme.type === "http" && scheme.scheme === "basic") {
      // Value is expected as "user:password".
      const encoded = Buffer.from(value).toString("base64");
      injection.headers["Authorization"] = `Basic ${encoded}`;
      return injection;
    }
    if (scheme.type === "apiKey") {
      if (scheme.in === "header") injection.headers[scheme.paramName] = value;
      else if (scheme.in === "query") injection.query[scheme.paramName] = value;
      else if (scheme.in === "cookie") {
        injection.headers["Cookie"] = `${scheme.paramName}=${value}`;
      }
      return injection;
    }
    if (scheme.type === "oauth2" || scheme.type === "openIdConnect") {
      // The credential value is the current OAuth / OIDC access token.
      injection.headers["Authorization"] = `Bearer ${value}`;
      return injection;
    }
  }

  return injection;
}

/**
 * Load credentials for each scheme from the environment. Convention:
 *   WRANGL_AUTH_<SCHEME_NAME>   (scheme name upper-cased, non-alnum → _)
 * Falls back to common generic vars so simple specs "just work".
 */
export function loadCredentialsFromEnv(
  schemes: Record<string, SecurityScheme>,
  env: NodeJS.ProcessEnv = process.env,
): CredentialStore {
  const creds: CredentialStore = {};
  for (const [name, scheme] of Object.entries(schemes)) {
    const specific = env[`WRANGL_AUTH_${envKey(name)}`];
    if (specific) {
      creds[name] = specific;
      continue;
    }
    // Generic fallbacks by scheme type.
    if (scheme.type === "http" && scheme.scheme === "bearer") {
      const v = env.WRANGL_BEARER_TOKEN ?? env.WRANGL_TOKEN;
      if (v) creds[name] = v;
    } else if (scheme.type === "apiKey") {
      const v = env.WRANGL_API_KEY;
      if (v) creds[name] = v;
    } else if (scheme.type === "http" && scheme.scheme === "basic") {
      const v = env.WRANGL_BASIC_AUTH;
      if (v) creds[name] = v;
    }
  }
  return creds;
}

/**
 * Parse `--auth scheme=value` CLI flags into a credential store. The scheme
 * name must match a securityScheme key from the spec.
 */
export function parseAuthFlags(flags: string[]): CredentialStore {
  const creds: CredentialStore = {};
  for (const flag of flags) {
    const eq = flag.indexOf("=");
    if (eq === -1) {
      throw new Error(`Invalid --auth value "${flag}". Expected scheme=value.`);
    }
    creds[flag.slice(0, eq)] = flag.slice(eq + 1);
  }
  return creds;
}

function envKey(name: string): string {
  return name.replace(/[^a-zA-Z0-9]+/g, "_").toUpperCase();
}
