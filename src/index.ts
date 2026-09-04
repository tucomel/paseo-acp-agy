#!/usr/bin/env node

import { ACPServer } from "./acp-server.js";
import { logger } from "./logger.js";
import { formatDiagnosticVersion, resolveBuildMetadata } from "./version.js";

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

Options:
  --acp          Start ACP server over stdio (default)
  -v, --version  Show version
  --json         Show version in JSON format (with --version)
  -h, --help     Show help

Environment Variables:
  AGY_ACP_LOG_LEVEL                 debug | info | warn | error (default: info)
  AGY_ACP_LOG_DIR                   Directory for log files
  AGY_ACP_SANDBOX                   Set to 'true' to run agy in sandbox mode
  AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS Set to 'true' to auto-approve tool permissions
  AGY_BIN_PATH                      Path to agy binary (default: agy in PATH or ~/.local/bin/agy)
`);
  process.exit(0);
}

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
