import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface McpServerStdioConfig {
  type: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
  alwaysLoad?: boolean;
}

export interface McpServerHttpConfig {
  type: "http" | "sse";
  url: string;
  headers?: Record<string, string>;
  alwaysLoad?: boolean;
}

export type McpServerConfig = McpServerStdioConfig | McpServerHttpConfig;

/**
 * Bridges Paseo session MCP servers into Google Antigravity CLI's MCP system.
 */
export class McpBridge {
  private registered = new Set<string>();

  constructor(private readonly binaryPath: string = "agy") {}

  /**
   * Syncs MCP servers configured by Paseo into Antigravity.
   */
  async syncServers(servers?: Record<string, McpServerConfig>): Promise<void> {
    if (!servers || typeof servers !== "object") return;

    for (const [name, config] of Object.entries(servers)) {
      if (!name || !config || typeof config !== "object") continue;
      const key = `${name}:${JSON.stringify(config)}`;
      if (this.registered.has(key)) continue;

      try {
        await this.addServer(name, config);
        this.registered.add(key);
        logger.info("Successfully synced MCP server from Paseo to Antigravity", { name, type: config.type });
      } catch (err) {
        logger.warn("Could not sync MCP server to Antigravity (continuing without it)", {
          name,
          error: (err as Error).message,
        });
      }
    }
  }

  private async addServer(name: string, config: McpServerConfig): Promise<void> {
    const args: string[] = ["mcp", "add"];

    if (config.type === "stdio") {
      if (config.env) {
        for (const [k, v] of Object.entries(config.env)) {
          args.push("--env", `${k}=${v}`);
        }
      }
      args.push(name, config.command);
      if (config.args && config.args.length > 0) {
        args.push(...config.args);
      }
    } else if (config.type === "http" || config.type === "sse") {
      if (config.headers) {
        for (const [k, v] of Object.entries(config.headers)) {
          args.push("--header", `${k}: ${v}`);
        }
      }
      args.push(name, config.url);
    }

    await execFileAsync(this.binaryPath, args, { timeout: 10_000 });
  }
}
