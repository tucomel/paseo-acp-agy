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
  process.stdout.write(`agy-acp - ACP adapter for Google Antigravity CLI\n\nUsage:\n  agy-acp [options]\n\nOptions:\n  -v, --version  Show version\n  -h, --help     Show help\n\nEnvironment Variables:\n  AGY_ACP_LOG_LEVEL                 debug | info | warn | error (default: info)\n  AGY_ACP_LOG_DIR                   Directory for log files\n  AGY_ACP_SANDBOX                   Set to 'true' to run agy in sandbox mode\n  AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS Set to 'true' to auto-approve tool permissions\n  AGY_BIN_PATH                      Path to agy binary (default: /home/ubuntu/.local/bin/agy)\n`);
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
