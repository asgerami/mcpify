import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/**
 * Agent-client integration: write a generated MCP server straight into the
 * config file of Claude Desktop / Cursor, so `mcpify install <api>` is the whole
 * setup. All these clients share the same `mcpServers` config shape.
 */

export type ClientName = "claude" | "cursor";

export interface McpServerEntry {
  command: string;
  args: string[];
}

/** Where each supported client keeps its MCP config, per platform. */
export function clientConfigPath(client: ClientName, home = homedir()): string {
  if (client === "cursor") return join(home, ".cursor", "mcp.json");

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

/**
 * How to re-invoke *this* CLI from a client config. Works whether MCPify is run
 * from source (tsx) or installed/compiled (node dist/cli.js), so the config we
 * write actually launches on the user's machine.
 */
export function selfCommand(entryPath = process.argv[1] ?? ""): McpServerEntry {
  const abs = resolve(entryPath);
  return abs.endsWith(".ts")
    ? { command: "npx", args: ["tsx", abs] }
    : { command: "node", args: [abs] };
}

/** Build the client entry that launches a generated MCP server over stdio. */
export function buildServerEntry(spec: string, baseUrl?: string): McpServerEntry {
  const self = selfCommand();
  const args = [...self.args, "generate", "--spec", spec];
  if (baseUrl) args.push("--base-url", baseUrl);
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
 * Merge one server into a client's MCP config, preserving every other entry.
 * Creates the file (and parent dirs) when missing, and backs up an existing one
 * before rewriting it.
 */
export function installServer(
  configPath: string,
  name: string,
  entry: McpServerEntry,
): InstallResult {
  let config: { mcpServers?: Record<string, McpServerEntry> } = {};
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

  const servers = config.mcpServers ?? {};
  const replaced = name in servers;
  config.mcpServers = { ...servers, [name]: entry };

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n");
  return { path: configPath, replaced, backup };
}

/** Human label for the restart hint after installing. */
export function clientLabel(client: ClientName): string {
  return client === "cursor" ? "Cursor" : "Claude Desktop";
}
