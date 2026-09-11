import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";

export interface PatchResult {
  found: boolean;
  serverPaths: string[];
  patchedPaths: string[];
  asarPaths?: string[];
  patchedAsarPaths?: string[];
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
      path.join(home, "AppData", "Roaming", "npm", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
      path.join(home, "AppData", "Roaming", "npm", "node_modules", "@getpaseo", "server"),
      path.join(home, ".npm-global", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
      path.join(home, ".npm-global", "node_modules", "@getpaseo", "server"),
    ];

    for (const loc of winLocations) {
      if (loc && fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }

    // Try detecting global npm root via npm.cmd
    try {
      const npmRoot = execFileSync("cmd.exe", ["/c", "npm.cmd", "root", "-g"], {
        encoding: "utf-8",
        timeout: 8000,
        windowsHide: true,
      }).trim();
      if (npmRoot && fs.existsSync(npmRoot)) {
        const p1 = path.join(npmRoot, "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(npmRoot, "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    } catch {}

    // Try detecting npm global prefix
    try {
      const npmPrefix = execFileSync("cmd.exe", ["/c", "npm.cmd", "config", "get", "prefix"], {
        encoding: "utf-8",
        timeout: 8000,
        windowsHide: true,
      }).trim();
      if (npmPrefix && fs.existsSync(npmPrefix)) {
        const p1 = path.join(npmPrefix, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(npmPrefix, "node_modules", "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    } catch {}

    // Check where.exe paseo across all output lines
    try {
      const whereOut = execFileSync("where.exe", ["paseo"], {
        encoding: "utf-8",
        timeout: 4000,
        windowsHide: true,
      }).trim();
      for (const line of whereOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const paseoDir = path.dirname(line);
        const checks = [
          path.join(paseoDir, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
          path.join(paseoDir, "node_modules", "@getpaseo", "server"),
          path.join(path.dirname(paseoDir), "node_modules", "@getpaseo", "server"),
          path.join(paseoDir, "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
          path.join(paseoDir, "resources", "app", "node_modules", "@getpaseo", "server"),
          path.join(path.dirname(paseoDir), "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
          path.join(path.dirname(paseoDir), "resources", "app", "node_modules", "@getpaseo", "server"),
        ];
        for (const c of checks) {
          if (fs.existsSync(c)) candidates.add(path.resolve(c));
        }
      }
    } catch {}

    // Search common PATH dirs for npm/node_modules
    if (process.env.PATH) {
      for (const p of process.env.PATH.split(";")) {
        const trimmed = p.trim();
        if (!trimmed || !fs.existsSync(trimmed)) continue;
        const p1 = path.join(trimmed, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server");
        const p2 = path.join(trimmed, "node_modules", "@getpaseo", "server");
        if (fs.existsSync(p1)) candidates.add(path.resolve(p1));
        if (fs.existsSync(p2)) candidates.add(path.resolve(p2));
      }
    }
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
  return `import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toneFromUsedPct, windowFromUsedPct, unavailableUsage } from "../usage.js";

const execFileAsync = promisify(execFile);

let cachedAgyBin = null;
let cachedAgyBinTime = 0;
const BIN_CACHE_TTL_MS = 30000;

function resolveAgyBinary() {
    if (process.env.AGY_BIN_PATH) return process.env.AGY_BIN_PATH;
    const now = Date.now();
    if (cachedAgyBin && (now - cachedAgyBinTime < BIN_CACHE_TTL_MS)) {
        return cachedAgyBin;
    }

    let resolved = "agy";
    const home = os.homedir();
    if (home) {
        if (process.platform === "win32") {
            const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
            const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
            const programFiles = process.env.ProgramFiles || "C:\\\\Program Files";
            const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\\\Program Files (x86)";

            // Prioritize .exe candidates over .cmd / .bat
            const exeCandidates = [
                path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
                path.join(localAppData, "Programs", "antigravity", "agy.exe"),
                path.join(localAppData, "Programs", "Antigravity", "agy.exe"),
                path.join(programFiles, "Antigravity", "bin", "agy.exe"),
                path.join(programFilesX86, "Antigravity", "bin", "agy.exe"),
                path.join(localAppData, "Microsoft", "WindowsApps", "agy.exe"),
                path.join(home, ".local", "bin", "agy.exe"),
                path.join(appData, "npm", "agy.exe"),
                path.join(localAppData, "npm", "agy.exe"),
            ];
            for (const cand of exeCandidates) {
                if (fs.existsSync(cand)) {
                    resolved = cand;
                    break;
                }
            }

            // Check where.exe agy and select first .exe
            if (resolved === "agy") {
                for (const target of ["agy", "agy.exe"]) {
                    try {
                        const out = execFileSync("where.exe", [target], { encoding: "utf-8", timeout: 2000, windowsHide: true }).trim();
                        const lines = out.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
                        const firstExe = lines.find(l => /\\.exe$/i.test(l) && fs.existsSync(l));
                        if (firstExe) {
                            resolved = firstExe;
                            break;
                        }
                    } catch {}
                }
            }

            // Fallback to batch scripts (.cmd / .bat) if no .exe found
            if (resolved === "agy") {
                const batchCandidates = [
                    path.join(appData, "npm", "agy.cmd"),
                    path.join(localAppData, "npm", "agy.cmd"),
                    path.join(home, ".local", "bin", "agy.cmd"),
                    path.join(appData, "npm", "agy.bat"),
                    path.join(localAppData, "npm", "agy.bat"),
                    path.join(home, ".local", "bin", "agy.bat"),
                ];
                for (const cand of batchCandidates) {
                    if (fs.existsSync(cand)) {
                        resolved = cand;
                        break;
                    }
                }
            }

            if (resolved === "agy") {
                for (const target of ["agy", "agy.cmd", "agy.bat"]) {
                    try {
                        const out = execFileSync("where.exe", [target], { encoding: "utf-8", timeout: 2000, windowsHide: true }).trim();
                        const lines = out.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
                        const firstAny = lines.find(l => /\\.(cmd|bat)$/i.test(l) && fs.existsSync(l));
                        if (firstAny) {
                            resolved = firstAny;
                            break;
                        }
                    } catch {}
                }
            }
        } else {
            const localPath = path.join(home, ".local", "bin", "agy");
            if (fs.existsSync(localPath)) resolved = localPath;
        }
    }

    cachedAgyBin = resolved;
    cachedAgyBinTime = now;
    return resolved;
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
            const bin = resolveAgyBinary();
            this.binaryPath = bin;
            const isBatch = isWin && /\\.(cmd|bat)$/i.test(bin);
            const [usageRes, creditsRes] = await Promise.allSettled([
                execFileAsync(bin, ["--print-timeout", "24h", "--print", "/usage"], { timeout: 15000, env: process.env, shell: isBatch, windowsHide: true }),
                execFileAsync(bin, ["--print-timeout", "24h", "--print", "/credits"], { timeout: 15000, env: process.env, shell: isBatch, windowsHide: true }),
            ]);

            const rawUsageOut = usageRes.status === "fulfilled" ? usageRes.value.stdout || usageRes.value.stderr : "";
            const rawCreditsOut = creditsRes.status === "fulfilled" ? creditsRes.value.stdout || creditsRes.value.stderr : "";

            const usageOut = (rawUsageOut || "").replace(/\\r\\n/g, "\\n");
            const creditsOut = (rawCreditsOut || "").replace(/\\r\\n/g, "\\n");

            const rawWindows = [];
            for (const line of usageOut.split("\\n")) {
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
          } else if (e.isFile() && e.name === "manifest.js" && dir.replace(/\\/g, "/").includes("quota-fetcher")) {
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
        const fetcherArrayRegex = /export\s+const\s+PROVIDER_USAGE_FETCHERS\s*=\s*\[/;
        if (fetcherArrayRegex.test(manifestCode)) {
          manifestCode = manifestCode.replace(fetcherArrayRegex, (match) => `${match}\n${entryToAdd}`);
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
        } else {
          const mapMatch = acpCode.match(/export\s+function\s+mapACPUsage\s*\([^)]*\)\s*\{/);
          if (mapMatch && mapMatch.index !== undefined) {
            const mapStart = mapMatch.index;
            const openBrace = acpCode.indexOf("{", mapStart);
            let depth = 1;
            let i = openBrace + 1;
            while (i < acpCode.length && depth > 0) {
              if (acpCode[i] === "{") depth++;
              else if (acpCode[i] === "}") depth--;
              i++;
            }
            if (depth === 0) {
              acpCode = acpCode.slice(0, mapStart) + newMap + acpCode.slice(i);
              acpModified = true;
            }
          }
        }
      }

      // Patch handleUsageUpdate
      if (acpCode.includes("handleUsageUpdate") && (!acpCode.includes("this.deliverTranslatedEvents") || acpCode.includes("this.notifySubscribers"))) {
        const startIdx = acpCode.search(/\bhandleUsageUpdate\s*\(/);
        if (startIdx !== -1) {
          const openBrace = acpCode.indexOf("{", startIdx);
          if (openBrace !== -1) {
            let depth = 1;
            let i = openBrace + 1;
            while (i < acpCode.length && depth > 0) {
              if (acpCode[i] === "{") depth++;
              else if (acpCode[i] === "}") depth--;
              i++;
            }
            if (depth === 0) {
              const newHandler = `handleUsageUpdate(update) {
        if (!update) return;
        const usage = mapACPUsage(update);
        if (usage) {
            this.currentTurnUsage = { ...this.currentTurnUsage, ...usage };
            const event = {
                type: "usage_updated",
                provider: this.provider,
                usage: this.currentTurnUsage,
                ...(this.activeForegroundTurnId ? { turnId: this.activeForegroundTurnId } : {}),
            };
            if (typeof this.deliverTranslatedEvents === "function") {
                this.deliverTranslatedEvents([event]);
            } else if (typeof this.pushEvent === "function") {
                this.pushEvent(event);
            }
        }
    }`;
              acpCode = acpCode.slice(0, startIdx) + newHandler + acpCode.slice(i);
              acpModified = true;
            }
          }
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
 * Searches the host machine for Paseo Desktop app.asar archives across
 * Windows, macOS, and Linux.
 */
export function findPaseoAsarPaths(): string[] {
  const candidates = new Set<string>();
  const home = os.homedir();

  if (process.env.PASEO_ASAR_PATH && fs.existsSync(process.env.PASEO_ASAR_PATH)) {
    candidates.add(path.resolve(process.env.PASEO_ASAR_PATH));
  }

  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
    const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    const winAsarLocations = [
      path.join(localAppData, "Programs", "Paseo", "resources", "app.asar"),
      path.join(localAppData, "Programs", "paseo", "resources", "app.asar"),
      path.join(localAppData, "Paseo", "resources", "app.asar"),
      path.join(programFiles, "Paseo", "resources", "app.asar"),
      path.join(programFiles, "paseo", "resources", "app.asar"),
      path.join(programFilesX86, "Paseo", "resources", "app.asar"),
      path.join(programFilesX86, "paseo", "resources", "app.asar"),
      path.join(appData, "Paseo", "resources", "app.asar"),
    ];

    for (const loc of winAsarLocations) {
      if (loc && fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }

    try {
      const whereOut = execFileSync("where.exe", ["paseo"], {
        encoding: "utf-8",
        timeout: 2000,
        windowsHide: true,
      }).trim();
      for (const line of whereOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        const asarCandidate1 = path.join(path.dirname(line), "resources", "app.asar");
        const asarCandidate2 = path.resolve(path.dirname(line), "..", "resources", "app.asar");
        const asarCandidate3 = path.resolve(line, "..", "..", "resources", "app.asar");
        for (const cand of [asarCandidate1, asarCandidate2, asarCandidate3]) {
          if (fs.existsSync(cand)) candidates.add(path.resolve(cand));
        }
      }
    } catch {}
  } else if (process.platform === "darwin") {
    const macLocations = [
      "/Applications/Paseo.app/Contents/Resources/app.asar",
      path.join(home, "Applications", "Paseo.app", "Contents", "Resources", "app.asar"),
    ];
    for (const loc of macLocations) {
      if (fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }
  } else {
    const linuxLocations = [
      "/opt/Paseo/resources/app.asar",
      "/usr/lib/paseo/resources/app.asar",
      path.join(home, ".local", "share", "paseo", "resources", "app.asar"),
    ];
    for (const loc of linuxLocations) {
      if (fs.existsSync(loc)) candidates.add(path.resolve(loc));
    }
  }

  return Array.from(candidates);
}

/**
 * Extracts, patches, and repacks a Paseo app.asar archive to integrate Antigravity
 * quota fetchers and token telemetry.
 */
export async function patchPaseoAsar(
  asarPath: string
): Promise<{ success: boolean; changes: string[]; error?: string }> {
  const changes: string[] = [];
  let tempDir: string | null = null;
  let tempAsar: string | null = null;

  try {
    if (!fs.existsSync(asarPath)) {
      return { success: false, changes: [], error: `Asar archive not found: ${asarPath}` };
    }

    // Dynamic import of @electron/asar
    const asarModule = await import("@electron/asar");
    const asar = (asarModule as any).default || asarModule;

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-asar-extract-"));
    asar.extractAll(asarPath, tempDir);

    // Look for server directory in extracted files
    const serverCandidates = [
      path.join(tempDir, "node_modules", "@getpaseo", "server"),
      path.join(tempDir, "dist", "node_modules", "@getpaseo", "server"),
    ];
    let serverDir = serverCandidates.find((c) => fs.existsSync(c));

    if (!serverDir) {
      // Search recursively within 3 levels
      const searchDirs = [tempDir];
      while (searchDirs.length > 0 && !serverDir) {
        const current = searchDirs.shift()!;
        try {
          const entries = fs.readdirSync(current, { withFileTypes: true });
          for (const ent of entries) {
            if (ent.isDirectory()) {
              const full = path.join(current, ent.name);
              const normalizedFull = full.replace(/\\/g, "/");
              if (ent.name === "server" && normalizedFull.includes("@getpaseo/server")) {
                serverDir = full;
                break;
              }
              if (full.split(path.sep).length - tempDir.split(path.sep).length < 4) {
                searchDirs.push(full);
              }
            }
          }
        } catch {}
      }
    }

    if (!serverDir) {
      return { success: false, changes: [], error: `Could not locate @getpaseo/server inside ${asarPath}` };
    }

    const patchResult = patchPaseoServer(serverDir);
    if (!patchResult.success) {
      return { success: false, changes: [], error: patchResult.error };
    }

    if (patchResult.changes.length === 0) {
      // Already patched!
      return { success: true, changes: [] };
    }

    changes.push(...patchResult.changes);

    // Create backup if not already present
    const backupPath = `${asarPath}.bak`;
    if (!fs.existsSync(backupPath)) {
      try {
        fs.copyFileSync(asarPath, backupPath);
        changes.push(`Backed up original asar to ${backupPath}`);
      } catch (backupErr) {
        logger.warn(`Could not create asar backup at ${backupPath}`, { error: String(backupErr) });
      }
    }

    tempAsar = path.join(os.tmpdir(), `app-${Date.now()}.asar`);
    await asar.createPackage(tempDir, tempAsar);

    // Replace original archive with locked file handling for Windows
    try {
      fs.copyFileSync(tempAsar, asarPath);
      changes.push(`Repacked updated asar archive at ${asarPath}`);
    } catch (copyErr: any) {
      if (copyErr && (copyErr.code === "EBUSY" || copyErr.code === "EPERM" || copyErr.code === "EACCES")) {
        const oldPath = `${asarPath}.old-${Date.now()}`;
        try {
          fs.renameSync(asarPath, oldPath);
          fs.copyFileSync(tempAsar, asarPath);
          changes.push(`Repacked updated asar archive at ${asarPath} (safe replaced locked file, moved previous to ${oldPath})`);
        } catch (renameErr) {
          throw new Error(
            `Cannot update ${asarPath}: file is locked by a running Paseo process (${copyErr.code}). Please close Paseo completely (Paseo.exe in system tray / Task Manager) and retry.`
          );
        }
      } else {
        throw copyErr;
      }
    }

    return { success: true, changes };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, changes, error: msg };
  } finally {
    if (tempDir) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }
    if (tempAsar) {
      try {
        fs.unlinkSync(tempAsar);
      } catch {}
    }
  }
}

/**
 * Discovers and patches all accessible Paseo installations (both directory and app.asar).
 */
export async function ensurePaseoIntegration(options?: {
  verbose?: boolean;
  targetPaths?: string[];
  targetAsarPaths?: string[];
}): Promise<PatchResult> {
  const serverPaths = options?.targetPaths || findPaseoServerInstallations();
  const asarPaths = options?.targetAsarPaths || findPaseoAsarPaths();
  const patchedPaths: string[] = [];
  const patchedAsarPaths: string[] = [];
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

  for (const aPath of asarPaths) {
    const res = await patchPaseoAsar(aPath);
    if (res.success) {
      if (res.changes.length > 0) {
        patchedAsarPaths.push(aPath);
        if (options?.verbose) {
          logger.info(`Integrated with Paseo desktop asar at ${aPath}`, { changes: res.changes });
        }
      }
    } else if (res.error) {
      errors.push(`${aPath}: ${res.error}`);
    }
  }

  return {
    found: serverPaths.length > 0 || asarPaths.length > 0,
    serverPaths,
    patchedPaths,
    asarPaths,
    patchedAsarPaths,
    errors,
  };
}

/**
 * Checks whether a @getpaseo/server installation directory is already patched
 * for Antigravity quota and telemetry support.
 */
export function isPaseoServerPatched(serverDir: string): boolean {
  try {
    if (!fs.existsSync(serverDir)) return false;

    const antigravityJsCandidates = [
      path.join(serverDir, "dist", "server", "services", "quota-fetcher", "providers", "antigravity.js"),
      path.join(serverDir, "dist", "services", "quota-fetcher", "providers", "antigravity.js"),
    ];
    let hasProvider = antigravityJsCandidates.some((p) => fs.existsSync(p));

    if (!hasProvider && fs.existsSync(path.join(serverDir, "dist"))) {
      const checkRecursive = (dir: string, depth = 0): boolean => {
        if (depth > 5) return false;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            if (e.isDirectory() && e.name !== "node_modules") {
              if (checkRecursive(path.join(dir, e.name), depth + 1)) return true;
            } else if (e.isFile() && e.name === "antigravity.js" && dir.replace(/\\/g, "/").includes("quota-fetcher")) {
              return true;
            }
          }
        } catch {}
        return false;
      };
      hasProvider = checkRecursive(path.join(serverDir, "dist"));
    }

    if (hasProvider) return true;

    const manifestCandidates = [
      path.join(serverDir, "dist", "server", "services", "quota-fetcher", "manifest.js"),
      path.join(serverDir, "dist", "services", "quota-fetcher", "manifest.js"),
    ];
    for (const cand of manifestCandidates) {
      if (fs.existsSync(cand)) {
        const content = fs.readFileSync(cand, "utf-8");
        if (content.includes('providerId: "antigravity"')) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}

/**
 * Checks whether a Paseo app.asar archive is already patched with Antigravity telemetry.
 */
export async function isPaseoAsarPatched(asarPath: string): Promise<boolean> {
  try {
    if (!fs.existsSync(asarPath)) return false;
    const asarModule = await import("@electron/asar");
    const asar = (asarModule as any).default || asarModule;
    const files: string[] = asar.listPackage(asarPath);
    return files.some((f) => f.includes("antigravity.js"));
  } catch {
    return false;
  }
}

/**
 * Detects if Paseo Desktop is currently running on the host.
 */
export function isPaseoRunning(): boolean {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist.exe", ["/FI", "IMAGENAME eq Paseo*", "/NH"], {
        encoding: "utf-8",
        timeout: 3000,
        windowsHide: true,
      });
      return /paseo/i.test(out) && !out.includes("INFO:") && !out.includes("No tasks");
    } else {
      const out = execFileSync("pgrep", ["-i", "-x", "paseo"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const pids = out
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => !isNaN(p) && p !== process.pid);
      return pids.length > 0;
    }
  } catch {
    return false;
  }
}
