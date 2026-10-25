#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { ACPServer } from "./acp-server.js";
import { logger } from "./logger.js";
import { formatDiagnosticVersion, resolveBuildMetadata } from "./version.js";
import {
  ensurePaseoIntegration,
  restorePaseoIntegration,
  findPaseoServerInstallations,
  findPaseoAsarPaths,
  isPaseoServerPatched,
  isPaseoAsarPatched,
  isPaseoRunning,
} from "./paseo-patcher.js";
import { resolveDefaultAgyBinary, isWindowsBatchScript } from "./antigravity-process.js";
import { parseAgyQuotaOutput } from "./protocol.js";

const args = process.argv.slice(2);
const bundledPluginDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "paseo-plugin");

if (args.includes("plugin-path") || args.includes("--plugin-path")) {
  process.stdout.write(`${bundledPluginDir}\n`);
  process.exit(0);
}

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
  npx -y paseo-acp-agy doctor

Commands:
  setup, patch   Configure and integrate Antigravity telemetry with Paseo
  doctor         Diagnose Antigravity binary, quota provider, and Paseo status
  restore        Restore original Paseo files from backup (.bak)
  plugin-path    Print path to the update-proof Paseo telemetry plugin directory

Options:
  --acp             Start ACP server over stdio (default)
  --setup           Integrate Antigravity with local Paseo server installation
  --doctor          Run environment, binary, and telemetry diagnostics
  --restore         Restore original Paseo files from backup
  --plugin-path     Print bundled Paseo plugin directory for 'paseo plugin install'
  --force-macos-app Force patching inside macOS .app bundle (re-signs with ad-hoc)
  --skip-naration   Drop leading narration-only assistant chunks (e.g. 'I will...')
  --skip-narration  Alias for --skip-naration
  -v, --version     Show version
  --json            Show version in JSON format (with --version)
  -h, --help        Show help

Environment Variables:
  AGY_ACP_LOG_LEVEL                 debug | info | warn | error (default: info)
  AGY_ACP_LOG_DIR                   Directory for log files
  AGY_ACP_SANDBOX                   Set to 'true' to run agy in sandbox mode
  AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS Set to 'true' to auto-approve tool permissions
  AGY_ACP_SKIP_NARRATION            Set to 'true' to drop leading narration chunks
  AGY_EXTRA_ARGS                    Extra space-separated CLI arguments passed to agy
  AGY_BIN_PATH                      Path to agy binary (default: agy in PATH or ~/.local/bin/agy)
  PASEO_SERVER_PATH                 Path to local @getpaseo/server directory
  PASEO_ASAR_PATH                   Path to local Paseo app.asar package
`);
  process.exit(0);
}

if (args.includes("doctor") || args.includes("--doctor")) {
  process.stdout.write("=== Paseo & Antigravity Doctor ===\n");
  process.stdout.write(`Operating System: ${process.platform} (${process.arch})\n`);
  process.stdout.write(`Node.js Version: ${process.version}\n`);
  process.stdout.write(`Paseo ACP Adapter: ${formatDiagnosticVersion()}\n\n`);

  process.stdout.write("1. Antigravity Binary Resolution:\n");
  const binPath = resolveDefaultAgyBinary(true);
  const exists = fs.existsSync(binPath);
  const isWin = process.platform === "win32";
  let execType = "Executable";
  if (isWin) {
    if (/\.exe$/i.test(binPath)) execType = "Native Windows Executable (.exe)";
    else if (/\.cmd$/i.test(binPath)) execType = "Windows Command Script (.cmd)";
    else if (/\.bat$/i.test(binPath)) execType = "Windows Batch Script (.bat)";
    else execType = "CLI command in PATH";
  } else {
    execType = "POSIX binary";
  }

  if (exists) {
    process.stdout.write(`  [OK] Binary found: ${binPath} (${execType})\n`);
  } else if (binPath === "agy") {
    process.stdout.write(`  [?] Binary fallback: 'agy' via system PATH (${execType})\n`);
  } else {
    process.stdout.write(`  [FAIL] Binary not found at: ${binPath}\n`);
  }

  process.stdout.write("\n2. CLI Telemetry & Runtime Probes:\n");
  const isBatch = isWin && isWindowsBatchScript(binPath);

  let modelsSuccess = false;
  let modelsCount = 0;
  const t0 = Date.now();
  try {
    const modelsOut = execFileSync(binPath, ["models"], {
      encoding: "utf-8",
      timeout: 15000,
      windowsHide: true,
      shell: isBatch,
    });
    const latency = Date.now() - t0;
    const modelLines = modelsOut
      .trim()
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => Boolean(l) && !l.toLowerCase().startsWith("models:"));
    modelsCount = modelLines.length;
    modelsSuccess = true;
    process.stdout.write(`  [OK] 'agy models' probe succeeded in ${latency}ms (${modelsCount} models detected)\n`);
  } catch (err: any) {
    const latency = Date.now() - t0;
    process.stdout.write(`  [WARN] 'agy models' probe failed in ${latency}ms: ${err?.message || String(err)}\n`);
  }

  let quotaSuccess = false;
  let quotaCount = 0;
  const t1 = Date.now();
  try {
    const usageOut = execFileSync(binPath, ["--print-timeout", "24h", "--print", "/usage"], {
      encoding: "utf-8",
      timeout: 15000,
      windowsHide: true,
      shell: isBatch,
    });
    const latency = Date.now() - t1;
    const normalized = usageOut.replace(/\r\n/g, "\n");
    const windows = parseAgyQuotaOutput(normalized);
    quotaCount = windows.length;
    quotaSuccess = true;
    process.stdout.write(`  [OK] 'agy --print /usage' probe succeeded in ${latency}ms (${quotaCount} quota limit item(s) parsed)\n`);
  } catch (err: any) {
    const latency = Date.now() - t1;
    process.stdout.write(`  [WARN] 'agy --print /usage' probe failed in ${latency}ms: ${err?.message || String(err)}\n`);
  }

  process.stdout.write("\n3. Paseo Installation Targets:\n");
  const serverPaths = findPaseoServerInstallations();
  const asarPaths = findPaseoAsarPaths();
  let telemetryPluginEnabled = false;
  try {
    const paseoHome =
      process.env.PASEO_HOME || path.join(process.env.HOME || process.env.USERPROFILE || "", ".paseo");
    const cfgPath = path.join(paseoHome, "config.json");
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
      if (cfg?.pluginsEnabled === true && cfg?.plugins) {
        const p = cfg.plugins["antigravity-telemetry"];
        if (p && p.enabled !== false) {
          telemetryPluginEnabled = true;
        }
      }
    }
  } catch {}
  process.stdout.write(
    `  - [Plugin] antigravity-telemetry -> ${telemetryPluginEnabled ? "[ENABLED]" : "[NOT INSTALLED]"}\n`
  );
  const totalFound = serverPaths.length + asarPaths.length;

  if (totalFound === 0) {
    process.stdout.write("  [!] No Paseo server or desktop installations discovered in standard paths.\n");
  } else {
    for (const sPath of serverPaths) {
      const patched = isPaseoServerPatched(sPath);
      process.stdout.write(`  - [Server] ${sPath} -> ${patched ? "[PATCHED]" : "[UNPATCHED]"}\n`);
    }
    for (const aPath of asarPaths) {
      const patched = await isPaseoAsarPatched(aPath);
      process.stdout.write(`  - [ASAR]   ${aPath} -> ${patched ? "[PATCHED]" : "[UNPATCHED]"}\n`);
    }
  }

  process.stdout.write("\n4. Paseo Process Status:\n");
  const paseoRunning = isPaseoRunning();
  if (paseoRunning) {
    process.stdout.write("  [!] Paseo process is currently running.\n");
    if (isWin) {
      process.stdout.write("      Tip: To restart Paseo completely on Windows, run in PowerShell:\n");
      process.stdout.write("        Stop-Process -Name \"Paseo\" -Force -ErrorAction SilentlyContinue\n");
      process.stdout.write("      Then launch Paseo again.\n");
    } else {
      process.stdout.write("      Tip: Run 'paseo restart' or close the Paseo app/daemon to reload with updated patches.\n");
    }
  } else {
    process.stdout.write("  [OK] Paseo is not currently running (safe to patch/update).\n");
  }

  process.stdout.write("\n=== Doctor Recommendations ===\n");
  let unpatchedCount = 0;
  for (const sPath of serverPaths) {
    if (!isPaseoServerPatched(sPath)) unpatchedCount++;
  }
  for (const aPath of asarPaths) {
    if (!(await isPaseoAsarPatched(aPath))) unpatchedCount++;
  }

  let hasIssue = false;
  if (!exists && binPath !== "agy") {
    hasIssue = true;
    process.stdout.write("  - Antigravity CLI ('agy') executable was not found.\n");
    process.stdout.write("    Action: Install Antigravity CLI or set AGY_BIN_PATH environment variable.\n");
  }

  if (totalFound === 0 && !telemetryPluginEnabled) {
    hasIssue = true;
    process.stdout.write("  - No Paseo installations found.\n");
    process.stdout.write("    Action: Set PASEO_SERVER_PATH or PASEO_ASAR_PATH to your Paseo install directory if located elsewhere.\n");
  } else if (unpatchedCount > 0 && !telemetryPluginEnabled) {
    hasIssue = true;
    process.stdout.write(`  - Found ${unpatchedCount} unpatched Paseo target(s) and 'antigravity-telemetry' plugin is not yet installed.\n`);
    process.stdout.write("    Recommended update-proof action (survives Paseo updates without touching .app signatures):\n");
    process.stdout.write(`      paseo plugin install "${bundledPluginDir}"\n`);
    if (isWin) {
      process.stdout.write("    Or to patch standalone Paseo after closing it (Stop-Process -Name \"Paseo\" -Force):\n");
      process.stdout.write("      npx -y paseo-acp-agy setup\n");
    } else {
      process.stdout.write("    Or for standalone @getpaseo/cli servers:\n");
      process.stdout.write("      npx -y paseo-acp-agy setup\n");
    }
  }

  if (!modelsSuccess || !quotaSuccess) {
    if (exists || binPath === "agy") {
      hasIssue = true;
      process.stdout.write("  - Antigravity CLI telemetry probes experienced errors.\n");
      process.stdout.write("    Action: Ensure you are logged in to Antigravity CLI (try running 'agy auth' or 'agy /status').\n");
    }
  }

  if (!hasIssue) {
    process.stdout.write("  [ALL OK] Everything is properly configured! Antigravity quota and telemetry are ready to use in Paseo.\n");
  }

  process.exit(0);
}

if (
  args.includes("restore") ||
  args.includes("unpatch") ||
  args.includes("--restore") ||
  args.includes("--unpatch")
) {
  process.stdout.write("Restoring original Paseo files from backup...\n");
  try {
    const res = await restorePaseoIntegration();
    if (res.restored.length > 0) {
      process.stdout.write(
        `Successfully restored original files:\n${res.restored.map((r) => `  - ${r}`).join("\n")}\n\n`
      );
    } else {
      process.stdout.write("No backup archives (.bak) found to restore.\n\n");
    }
    if (res.errors.length > 0) {
      process.stderr.write(`Errors during restore:\n${res.errors.map((e) => `  - ${e}`).join("\n")}\n`);
    }
  } catch (err) {
    process.stderr.write(`Restore encountered an issue: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(0);
}

if (
  args.includes("setup") ||
  args.includes("patch") ||
  args.includes("--setup") ||
  args.includes("--patch")
) {
  if (isPaseoRunning()) {
    process.stdout.write(
      "Notice: Paseo appears to be running. If setup fails with EBUSY, please close Paseo completely (from system tray / task manager) and re-run setup.\n\n"
    );
  }
  process.stdout.write("Checking Paseo installation and configuring Antigravity telemetry...\n");
  try {
    const forceMacosApp = args.includes("--force-macos-app");
    const res = await ensurePaseoIntegration({ verbose: true, forceMacosApp });
    if (!res.found) {
      process.stdout.write(
        "Notice: No active @getpaseo/server installation or app.asar found in standard paths.\n" +
        "If Paseo is installed in a custom directory, set PASEO_SERVER_PATH or PASEO_ASAR_PATH and run setup again.\n"
      );
    } else {
      const totalFound = res.serverPaths.length + (res.asarPaths?.length || 0) + (res.skippedPaths?.length || 0);
      process.stdout.write(
        `Found ${totalFound} Paseo installation target(s) (${res.serverPaths.length} server dir(s), ${res.asarPaths?.length || 0} asar package(s)` +
        (res.skippedPaths && res.skippedPaths.length > 0 ? `, ${res.skippedPaths.length} protected macOS app bundle(s)` : "") +
        `).\n`
      );
      const allPatched = [...res.patchedPaths, ...(res.patchedAsarPaths || [])];
      if (allPatched.length > 0) {
        process.stdout.write(
          `Successfully integrated with: \n${allPatched.map((p) => `  - ${p}`).join("\n")}\n\n` +
          `Antigravity quota provider and context-window telemetry are now enabled!\n`
        );
      } else if (res.skippedPaths && res.skippedPaths.length > 0) {
        process.stdout.write("Paseo server is ready. macOS .app bundle signature was preserved.\n");
      } else {
        process.stdout.write("Paseo is already up-to-date and configured for Antigravity telemetry.\n");
      }

      if (res.skippedPaths && res.skippedPaths.length > 0) {
        process.stdout.write(
          `\n🛡️  Preserved macOS Code Signature:\n` +
          `   Skipped ${res.skippedPaths.length} target(s) inside macOS .app bundle to protect official Apple Developer ID signature\n` +
          `   and prevent Gatekeeper "damaged app" warnings.\n` +
          `   Recommended update-proof telemetry setup (survives every Paseo update):\n` +
          `     paseo plugin install "${bundledPluginDir}"\n` +
          `   (Or if you specifically wish to patch the .app bundle: paseo-acp-agy patch --force-macos-app)\n\n`
        );
      }

      if (isPaseoRunning()) {
        const isWin = process.platform === "win32";
        process.stdout.write(
          `\n⚠️  IMPORTANT: Paseo is currently running in the background!\n` +
          (isWin
            ? `   Windows caches running executables in memory, so changes will only take effect after restarting Paseo.\n` +
              `   In PowerShell, run:\n` +
              `     Stop-Process -Name "Paseo" -Force -ErrorAction SilentlyContinue\n` +
              `   Then launch Paseo again.\n\n`
            : `   Changes will only take effect after restarting the Paseo daemon/app.\n` +
              `   Run 'paseo restart' or close the Paseo app to reload.\n\n`)
        );
      } else {
        process.stdout.write(`Please start Paseo to apply changes.\n\n`);
      }
      if (res.errors.length > 0) {
        process.stderr.write(`Notice: Some paths could not be modified (may require admin/close Paseo):\n${res.errors.map(e => `  - ${e}`).join("\n")}\n`);
      }
    }
  } catch (err) {
    process.stderr.write(`Setup encountered an issue: ${err instanceof Error ? err.message : String(err)}\n`);
  }
  process.exit(0);
}

// Auto-run integration in background when starting ACP server
void ensurePaseoIntegration().catch(() => {});

const skipNarration =
  args.includes("--skip-naration") ||
  args.includes("--skip-narration") ||
  process.env.AGY_ACP_SKIP_NARRATION === "true";

process.on("uncaughtException", (err) => {
  if ((err as NodeJS.ErrnoException).code === "EPIPE") {
    logger.debug("Suppressed EPIPE in uncaughtException");
    return;
  }
  logger.error("Uncaught exception in agy-acp process", { error: err.message, stack: err.stack });
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection in agy-acp process", {
    reason: reason instanceof Error ? reason.message : String(reason),
    stack: reason instanceof Error ? reason.stack : undefined,
  });
});

const server = new ACPServer({ skipNarration });

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

server.on("close", () => {
  process.exit(0);
});

server.start();

