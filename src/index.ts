#!/usr/bin/env node

import { ACPServer } from "./acp-server.js";
import { logger } from "./logger.js";
import { formatDiagnosticVersion, resolveBuildMetadata } from "./version.js";
import { ensurePaseoIntegration } from "./paseo-patcher.js";

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  if (args.includes("--json")) {
    process.stdout.write(JSON.stringify(resolveBuildMetadata(), null, 2) + "\n");
  } else {
    process.stdout.write(`${formatDiagnosticVersion()}\n`);
  }
  process.exit(0);
}

if (args.includes("--help") || args.includes("-h")) {
  process.stdout.write(`paseo-acp-agy - ACP adapter for Google Antigravity CLI

Usage:
  paseo-acp-agy [options]
  agy-acp [options]
  npx -y paseo-acp-agy [options]
  npx -y paseo-acp-agy setup

Commands:
  setup, patch   Configure and integrate Antigravity telemetry with Paseo

Options:
  --acp          Start ACP server over stdio (default)
  --setup        Integrate Antigravity with local Paseo server installation
  -v, --version  Show version
  --json         Show version in JSON format (with --version)
  -h, --help     Show help

Environment Variables:
  AGY_ACP_LOG_LEVEL                 debug | info | warn | error (default: info)
  AGY_ACP_LOG_DIR                   Directory for log files
  AGY_ACP_SANDBOX                   Set to 'true' to run agy in sandbox mode
  AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS Set to 'true' to auto-approve tool permissions
  AGY_BIN_PATH                      Path to agy binary (default: agy in PATH or ~/.local/bin/agy)
  PASEO_SERVER_PATH                 Path to local @getpaseo/server directory
`);
  process.exit(0);
}

if (
  args.includes("setup") ||
  args.includes("patch") ||
  args.includes("--setup") ||
  args.includes("--patch")
) {
  process.stdout.write("Checking Paseo installation and configuring Antigravity telemetry...\n");
  try {
    const res = ensurePaseoIntegration({ verbose: true });
    if (!res.found) {
      process.stdout.write(
        "Notice: No active @getpaseo/server installation found in standard paths.\n" +
        "If Paseo is installed in a custom directory, set PASEO_SERVER_PATH and run setup again.\n"
      );
    } else {
      process.stdout.write(
        `Found ${res.serverPaths.length} Paseo server installation(s).\n`
      );
      if (res.patchedPaths.length > 0) {
        process.stdout.write(
          `Successfully integrated with: \n${res.patchedPaths.map((p) => `  - ${p}`).join("\n")}\n\n` +
          `Antigravity quota provider and context-window telemetry are now enabled!\n` +
          `Please restart Paseo (or run 'paseo daemon restart') to apply changes.\n`
        );
      } else {
        process.stdout.write("Paseo is already up-to-date and configured for Antigravity telemetry.\n");
      }
    }
  } catch (err) {
    process.stderr.write(`Setup encountered an issue: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(0);
}

// Auto-run integration in background when starting ACP server
try {
  ensurePaseoIntegration();
} catch {}

const server = new ACPServer();

const cleanup = async () => {
  try {
    await server.stop();
    logger.close();
  } catch (err) {
    // ignore
  }
  process.exit(0);
};

process.on("SIGINT", cleanup);
process.on("SIGTERM", cleanup);

server.start();
