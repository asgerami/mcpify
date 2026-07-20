import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Agent-client integration: write a generated MCP server straight into the
 * config file of an agent client, so `wrangl install <api>` is the whole
 * setup. Claude Desktop, Cursor, Windsurf, and Cline all share the same
 * `mcpServers` config shape; Zed (`context_servers`) and VS Code (`servers`)
 * use their own top-level key and per-entry fields.
 */

export const CLIENT_NAMES = ["claude", "cursor", "windsurf", "cline", "zed", "vscode"] as const;
export type ClientName = (typeof CLIENT_NAMES)[number];

export function isClientName(value: string): value is ClientName {
  return (CLIENT_NAMES as readonly string[]).includes(value);
}

export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Where each supported client keeps its MCP config, per platform. */
export function clientConfigPath(
  client: ClientName,
  home = homedir(),
  cwd = process.cwd(),
): string {
  if (client === "cursor") return join(home, ".cursor", "mcp.json");
  if (client === "windsurf") return join(home, ".codeium", "windsurf", "mcp_config.json");

  // VS Code's native MCP support reads a workspace-relative file.
  if (client === "vscode") return join(cwd, ".vscode", "mcp.json");

  // Cline (VS Code extension) keeps its own settings apart from VS Code's own mcp.json.
  if (client === "cline") {
    if (process.platform === "darwin") {
      return join(
        home,
        "Library",
        "Application Support",
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    }
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(
        appData,
        "Code",
        "User",
        "globalStorage",
        "saoudrizwan.claude-dev",
        "settings",
        "cline_mcp_settings.json",
      );
    }
    return join(
      home,
      ".config",
      "Code",
      "User",
      "globalStorage",
      "saoudrizwan.claude-dev",
      "settings",
      "cline_mcp_settings.json",
    );
  }

  // Zed keeps MCP entries in its general settings.json under "context_servers".
  if (client === "zed") {
    if (process.platform === "win32") {
      const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
      return join(appData, "Zed", "settings.json");
    }
    return join(home, ".config", "zed", "settings.json");
  }

  // Claude Desktop
  if (process.platform === "darwin") {
    return join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? join(home, "AppData", "Roaming");
    return join(appData, "Claude", "claude_desktop_config.json");
  }
  return join(home, ".config", "Claude", "claude_desktop_config.json");
}

/** The top-level config key each client reads its server list from. */
export function clientConfigKey(client: ClientName): string {
  if (client === "vscode") return "servers";
  if (client === "zed") return "context_servers";
  return "mcpServers";
}

/** Shape a generic server entry into what this client's config expects. */
export function clientEntry(client: ClientName, entry: McpServerEntry): Record<string, unknown> {
  if (client === "vscode") return { type: "stdio", command: entry.command, args: entry.args };
  if (client === "zed") return { source: "custom", command: entry.command, args: entry.args };
  return { ...entry };
}

/**
 * How to re-invoke *this* CLI from a client config. Works whether Wrangl is run
 * from source (tsx) or installed/compiled (node dist/cli.js), so the config we
 * write actually launches on the user's machine.
 */
export function selfCommand(entryPath = process.argv[1] ?? ""): McpServerEntry {
  const abs = resolve(entryPath);
  return abs.endsWith(".ts")
    ? { command: "npx", args: ["tsx", abs] }
    : { command: "node", args: [abs] };
}

/** Optional flags forwarded into the generated `wrangl generate` command. */
export interface BuildServerEntryOptions {
  baseUrl?: string;
  include?: string[];
  exclude?: string[];
}

/** Build the client entry that launches a generated MCP server over stdio. */
export function buildServerEntry(
  spec: string,
  baseUrlOrOpts?: string | BuildServerEntryOptions,
): McpServerEntry {
  const opts: BuildServerEntryOptions =
    typeof baseUrlOrOpts === "string" || baseUrlOrOpts === undefined
      ? { baseUrl: baseUrlOrOpts }
      : baseUrlOrOpts;
  const self = selfCommand();
  const args = [...self.args, "generate", "--spec", spec];
  if (opts.baseUrl) args.push("--base-url", opts.baseUrl);
  for (const pattern of opts.include ?? []) args.push("--include", pattern);
  for (const pattern of opts.exclude ?? []) args.push("--exclude", pattern);
  return { command: self.command, args };
}

export interface InstallResult {
  path: string;
  /** True when an entry with this name already existed and was replaced. */
  replaced: boolean;
  /** Path of the backup written before overwriting an existing config. */
  backup?: string;
}

/**
 * Merge one server into a client's MCP config, preserving every other entry
 * (including unrelated settings in shared files like Zed's settings.json).
 * Creates the file (and parent dirs) when missing, and backs up an existing
 * one before rewriting it.
 */
export function installServer(
  configPath: string,
  name: string,
  entry: McpServerEntry | Record<string, unknown>,
  configKey = "mcpServers",
): InstallResult {
  let config: Record<string, unknown> = {};
  let backup: string | undefined;

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf8").trim();
    if (raw) {
      try {
        config = JSON.parse(raw);
      } catch {
        throw new Error(
          `${configPath} is not valid JSON — fix or move it before installing.`,
        );
      }
    }
    // Never clobber a config without a copy to fall back to.
    backup = `${configPath}.bak`;
    copyFileSync(configPath, backup);
  }

  const servers = (config[configKey] as Record<string, unknown>) ?? {};
  const replaced = name in servers;
  config[configKey] = { ...servers, [name]: entry };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { path: configPath, replaced, backup };
}

/** Human label for the restart hint after installing. */
export function clientLabel(client: ClientName): string {
  switch (client) {
    case "cursor":
      return "Cursor";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "zed":
      return "Zed";
    case "vscode":
      return "VS Code";
    default:
      return "Claude Desktop";
  }
}
