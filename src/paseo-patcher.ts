import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";

export interface PatchResult {
  found: boolean;
  serverPaths: string[];
  patchedPaths: string[];
  errors: string[];
}

/**
 * Searches the host machine for @getpaseo/server installations across
 * Windows, macOS, and Linux.
 */
export function findPaseoServerInstallations(): string[] {
  const candidates = new Set<string>();

  // 1. Explicit environment variable overrides
  if (process.env.PASEO_SERVER_PATH && fs.existsSync(process.env.PASEO_SERVER_PATH)) {
    candidates.add(path.resolve(process.env.PASEO_SERVER_PATH));
  }
  if (process.env.PASEO_INSTALL_DIR && fs.existsSync(process.env.PASEO_INSTALL_DIR)) {
    const direct = path.join(process.env.PASEO_INSTALL_DIR, "node_modules", "@getpaseo", "server");
    if (fs.existsSync(direct)) candidates.add(path.resolve(direct));
  }

  // 2. Platform-specific default paths
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";

    const winLocations = [
      path.join(appData, "npm", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
      path.join(appData, "npm", "node_modules", "@getpaseo", "server"),
      path.join(localAppData, "npm", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
      path.join(localAppData, "npm", "node_modules", "@getpaseo", "server"),
      path.join(programFiles, "nodejs", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
      path.join(programFiles, "nodejs", "node_modules", "@getpaseo", "server"),
      path.join(localAppData, "Programs", "Paseo", "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
      path.join(localAppData, "Programs", "Paseo", "resources", "app", "node_modules", "@getpaseo", "server"),
      path.join(programFiles, "Paseo", "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
    ];

    for (const loc of winLocations) {
      if (loc && fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }

    // Try detecting global npm root via npm.cmd
    try {
      const npmRoot = execFileSync("cmd.exe", ["/c", "npm.cmd", "root", "-g"], {
        encoding: "utf-8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
      if (npmRoot && fs.existsSync(npmRoot)) {
        const p1 = path.join(npmRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(npmRoot, "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    } catch {}

    // Check where.exe paseo
    try {
      const whereOut = execFileSync("where.exe", ["paseo"], {
        encoding: "utf-8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
      const first = whereOut.split(/\r?\n/)[0]?.trim();
      if (first) {
        const paseoDir = path.dirname(first);
        const p1 = path.join(paseoDir, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(paseoDir, "node_modules", "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    } catch {}
  } else {
    // POSIX locations (Linux / macOS)
    const posixLocations = [
      "/usr/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server",
      "/usr/lib/node_modules/@getpaseo/server",
      "/usr/local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server",
      "/usr/local/lib/node_modules/@getpaseo/server",
      "/Applications/Paseo.app/Contents/Resources/app.asar.unpacked/node_modules/@getpaseo/server",
      "/Applications/Paseo.app/Contents/Resources/app/node_modules/@getpaseo/server",
    ];

    if (home) {
      posixLocations.push(
        path.join(home, ".local", "share", "pnpm", "global", "5", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
        path.join(home, ".bun", "install", "global", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server")
      );

      // Check nvm paths if available
      const nvmDir = path.join(home, ".nvm", "versions", "node");
      if (fs.existsSync(nvmDir)) {
        try {
          const versions = fs.readdirSync(nvmDir);
          for (const ver of versions) {
            posixLocations.push(
              path.join(nvmDir, ver, "lib", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
              path.join(nvmDir, ver, "lib", "node_modules", "@getpaseo", "server")
            );
          }
        } catch {}
      }
    }

    for (const loc of posixLocations) {
      if (fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }

    try {
      const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf-8", timeout: 2000 }).trim();
      if (npmRoot && fs.existsSync(npmRoot)) {
        const p1 = path.join(npmRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(npmRoot, "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    } catch {}
  }

  // Filter out any paths that do not actually have a dist directory or package.json
  const verified: string[] = [];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "dist")) || fs.existsSync(path.join(dir, "package.json"))) {
      verified.push(dir);
    }
  }

  return verified;
}

/**
 * Returns the JavaScript source for the Antigravity quota provider to be
 * injected into Paseo server's quota-fetcher providers.
 */
export function generateAntigravityQuotaProviderJs(): string {
  return `import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toneFromUsedPct, windowFromUsedPct, unavailableUsage } from "../usage.js";

const execFileAsync = promisify(execFile);

function resolveAgyBinary() {
    if (process.env.AGY_BIN_PATH) return process.env.AGY_BIN_PATH;
    const home = os.homedir();
    if (home) {
        if (process.platform === "win32") {
            const candidates = [
                path.join(home, ".local", "bin", "agy.exe"),
                path.join(home, "AppData", "Local", "Programs", "antigravity", "agy.exe"),
                path.join(home, ".local", "bin", "agy.cmd"),
                path.join(home, ".local", "bin", "agy.bat"),
            ];
            for (const cand of candidates) {
                if (fs.existsSync(cand)) return cand;
            }
            try {
                const { execFileSync } = require("node:child_process");
                const out = execFileSync("where.exe", ["agy"], { encoding: "utf-8", timeout: 1000 }).trim();
                const first = out.split(/\\r?\\n/)[0]?.trim();
                if (first && fs.existsSync(first)) return first;
            } catch {}
        } else {
            const localPath = path.join(home, ".local", "bin", "agy");
            if (fs.existsSync(localPath)) return localPath;
        }
    }
    return "agy";
}

export class AntigravityQuotaProvider {
    constructor(options) {
        this.providerId = "antigravity";
        this.displayName = "Antigravity";
        this.logger = typeof options?.logger?.child === "function" ? options.logger.child({ module: "antigravity-quota-provider" }) : options?.logger;
        this.binaryPath = resolveAgyBinary();
    }

    async fetchUsage() {
        try {
            const isWin = process.platform === "win32";
            const [usageRes, creditsRes] = await Promise.allSettled([
                execFileAsync(this.binaryPath, ["--print", "/usage"], { timeout: 8000, env: process.env, shell: isWin }),
                execFileAsync(this.binaryPath, ["--print", "/credits"], { timeout: 8000, env: process.env, shell: isWin }),
            ]);

            const usageOut = usageRes.status === "fulfilled" ? usageRes.value.stdout || usageRes.value.stderr : "";
            const creditsOut = creditsRes.status === "fulfilled" ? creditsRes.value.stdout || creditsRes.value.stderr : "";

            const rawWindows = [];
            for (const line of usageOut.split(/[\\r\\n]+/)) {
                const trimmed = line.trim();
                if (!trimmed || trimmed.toLowerCase().startsWith("quota:")) continue;

                let scope = "";
                let limitType = "";
                let remainingPct = null;
                let resetsAt = null;

                const m = trimmed.match(/^(.*?)\\s{2,}(.*?Remaining)\\s+(\\d+)%(?:\\s+(.*))?$/i);
                if (m) {
                    scope = m[1].trim();
                    limitType = m[2].trim();
                    remainingPct = parseInt(m[3], 10);
                    resetsAt = m[4] ? new Date(m[4].trim()).toISOString() : null;
                } else {
                    const parts = trimmed.split(/\\t+|\\s{2,}/).map(p => p.trim());
                    if (parts.length >= 3) {
                        scope = parts[0];
                        limitType = parts[1];
                        const remMatch = parts[2].match(/(\\d+)%/);
                        if (remMatch) remainingPct = parseInt(remMatch[1], 10);
                        resetsAt = parts[3] ? new Date(parts[3]).toISOString() : null;
                    }
                }

                if (remainingPct !== null && !isNaN(remainingPct)) {
                    const usedPct = Math.max(0, Math.min(100, 100 - remainingPct));
                    const isFiveHour = /five\\s*hour/i.test(limitType);
                    const isWeekly = /weekly/i.test(limitType);
                    const isGemini = /gemini/i.test(scope);

                    let id = isFiveHour ? "session" : isWeekly ? "weekly" : "quota";
                    let label = isFiveHour ? "Session" : isWeekly ? "Weekly" : limitType.replace(/\\s+Remaining$/i, "");
                    if (!isGemini) {
                        id = \`claude_\${id}\`;
                        label = \`Claude \${label}\`;
                    }

                    rawWindows.push({
                        id,
                        label,
                        utilizationPct: usedPct,
                        resetsAt,
                        tone: toneFromUsedPct(usedPct),
                        isFiveHour,
                        isGemini,
                    });
                }
            }

            rawWindows.sort((a, b) => {
                if (a.isGemini && !b.isGemini) return -1;
                if (!a.isGemini && b.isGemini) return 1;
                if (a.isFiveHour && !b.isFiveHour) return -1;
                if (!a.isFiveHour && b.isFiveHour) return 1;
                return 0;
            });

            const windows = rawWindows.map(w => windowFromUsedPct(w));

            const balances = [];
            const credMatch = creditsOut.match(/Remaining\\s+credits\\s+([\\d.]+)/i);
            const remainingCredits = credMatch ? parseFloat(credMatch[1]) : 0;
            balances.push({
                id: "credits",
                label: "Credits",
                remaining: remainingCredits,
                unit: "usd",
                tone: remainingCredits > 0 ? "ok" : "default",
            });

            return {
                providerId: this.providerId,
                displayName: "Antigravity",
                status: "available",
                planLabel: "Google Gemini",
                windows,
                balances,
                details: [],
                error: null,
            };
        } catch (err) {
            return unavailableUsage({
                providerId: this.providerId,
                displayName: "Antigravity",
                error: err.message,
            });
        }
    }
}
`;
}

/**
 * Patches a Paseo server installation directory to enable Antigravity:
 * 1. Patches quota-fetcher/manifest.js to register Antigravity
 * 2. Writes quota-fetcher/providers/antigravity.js
 * 3. Patches acp-agent.js to map context window tokens and emit usage updates
 */
export function patchPaseoServer(serverDir: string): { success: boolean; changes: string[]; error?: string } {
  const changes: string[] = [];
  try {
    // 1. Locate manifest.js in quota-fetcher
    const manifestCandidates = [
      path.join(serverDir, "dist", "server", "services", "quota-fetcher", "manifest.js"),
      path.join(serverDir, "dist", "services", "quota-fetcher", "manifest.js"),
    ];
    let manifestFile = manifestCandidates.find((f) => fs.existsSync(f));

    if (!manifestFile && fs.existsSync(path.join(serverDir, "dist"))) {
      const findManifest = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && e.name !== "node_modules") {
            const found = findManifest(full);
            if (found) return found;
          } else if (e.isFile() && e.name === "manifest.js" && dir.includes("quota-fetcher")) {
            return full;
          }
        }
        return null;
      };
      manifestFile = findManifest(path.join(serverDir, "dist")) || undefined;
    }

    if (manifestFile) {
      const quotaDir = path.dirname(manifestFile);
      const providersDir = path.join(quotaDir, "providers");
      if (!fs.existsSync(providersDir)) {
        fs.mkdirSync(providersDir, { recursive: true });
      }

      // Write / update providers/antigravity.js
      const antigravityJsPath = path.join(providersDir, "antigravity.js");
      fs.writeFileSync(antigravityJsPath, generateAntigravityQuotaProviderJs(), "utf-8");
      changes.push(`Created/Updated ${antigravityJsPath}`);

      // Patch manifest.js
      let manifestCode = fs.readFileSync(manifestFile, "utf-8");
      let manifestModified = false;

      if (!manifestCode.includes('from "./providers/antigravity.js"') && !manifestCode.includes("AntigravityQuotaProvider")) {
        manifestCode = `import { AntigravityQuotaProvider } from "./providers/antigravity.js";\n` + manifestCode;
        manifestModified = true;
      }

      if (!manifestCode.includes('providerId: "antigravity"')) {
        const entryToAdd = `    {\n        providerId: "antigravity",\n        create: (options) => new AntigravityQuotaProvider({\n            logger: options.logger,\n            fetch: options.fetch,\n        }),\n    },\n`;
        const marker = "export const PROVIDER_USAGE_FETCHERS = [";
        if (manifestCode.includes(marker)) {
          manifestCode = manifestCode.replace(marker, `${marker}\n${entryToAdd}`);
          manifestModified = true;
        }
      }

      if (manifestModified) {
        fs.writeFileSync(manifestFile, manifestCode, "utf-8");
        changes.push(`Patched ${manifestFile} with AntigravityQuotaProvider`);
      }
    }

    // 2. Locate acp-agent.js
    const acpCandidates = [
      path.join(serverDir, "dist", "server", "server", "agent", "providers", "acp-agent.js"),
      path.join(serverDir, "dist", "server", "agent", "providers", "acp-agent.js"),
      path.join(serverDir, "dist", "agent", "providers", "acp-agent.js"),
    ];
    let acpFile = acpCandidates.find((f) => fs.existsSync(f));

    if (!acpFile && fs.existsSync(path.join(serverDir, "dist"))) {
      const findAcp = (dir: string): string | null => {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const e of entries) {
          const full = path.join(dir, e.name);
          if (e.isDirectory() && e.name !== "node_modules") {
            const found = findAcp(full);
            if (found) return found;
          } else if (e.isFile() && e.name === "acp-agent.js") {
            return full;
          }
        }
        return null;
      };
      acpFile = findAcp(path.join(serverDir, "dist")) || undefined;
    }

    if (acpFile) {
      let acpCode = fs.readFileSync(acpFile, "utf-8");
      let acpModified = false;

      // Patch mapACPUsage
      if (!acpCode.includes("contextWindowMaxTokens: usage.contextWindowMaxTokens")) {
        const oldMapRegex = /export\s+function\s+mapACPUsage\s*\([^)]*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/m;
        const newMap = `export function mapACPUsage(usage) {
    if (!usage) {
        return undefined;
    }
    return {
        inputTokens: usage.inputTokens ?? undefined,
        outputTokens: usage.outputTokens ?? undefined,
        cachedInputTokens: usage.cachedReadTokens ?? usage.cachedInputTokens ?? undefined,
        totalCostUsd: usage.totalCostUsd ?? (usage.cost?.amount !== undefined ? Number(usage.cost.amount) : undefined),
        contextWindowMaxTokens: usage.contextWindowMaxTokens ?? usage.size ?? undefined,
        contextWindowUsedTokens: usage.contextWindowUsedTokens ?? usage.used ?? undefined,
    };
}`;
        if (oldMapRegex.test(acpCode)) {
          acpCode = acpCode.replace(oldMapRegex, newMap);
          acpModified = true;
        }
      }

      // Patch handleUsageUpdate
      if (acpCode.includes("handleUsageUpdate(update) {") && !acpCode.includes("this.notifySubscribers({")) {
        const oldHandlerRegex = /handleUsageUpdate\s*\(\s*update\s*\)\s*\{[\s\S]*?void\s+update;?[\s\S]*?\}/m;
        const newHandler = `handleUsageUpdate(update) {
        if (!update) return;
        const usage = mapACPUsage(update);
        if (usage) {
            this.currentTurnUsage = { ...this.currentTurnUsage, ...usage };
            this.notifySubscribers({
                type: "usage_updated",
                provider: this.provider,
                usage: this.currentTurnUsage,
                ...(this.activeForegroundTurnId ? { turnId: this.activeForegroundTurnId } : {}),
            });
        }
    }`;
        if (oldHandlerRegex.test(acpCode)) {
          acpCode = acpCode.replace(oldHandlerRegex, newHandler);
          acpModified = true;
        }
      }

      if (acpModified) {
        fs.writeFileSync(acpFile, acpCode, "utf-8");
        changes.push(`Patched ${acpFile} for context-window token telemetry and usage updates`);
      }
    }

    return { success: true, changes };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    logger.warn("Failed to patch Paseo server", { serverDir, error: errorMsg });
    return { success: false, changes, error: errorMsg };
  }
}

/**
 * Discovers and patches all accessible Paseo installations.
 */
export function ensurePaseoIntegration(options?: { verbose?: boolean; targetPaths?: string[] }): PatchResult {
  const serverPaths = options?.targetPaths || findPaseoServerInstallations();
  const patchedPaths: string[] = [];
  const errors: string[] = [];

  for (const sPath of serverPaths) {
    const res = patchPaseoServer(sPath);
    if (res.success) {
      if (res.changes.length > 0) {
        patchedPaths.push(sPath);
        if (options?.verbose) {
          logger.info(`Integrated with Paseo server at ${sPath}`, { changes: res.changes });
        }
      }
    } else if (res.error) {
      errors.push(`${sPath}: ${res.error}`);
    }
  }

  return {
    found: serverPaths.length > 0,
    serverPaths,
    patchedPaths,
    errors,
  };
}
