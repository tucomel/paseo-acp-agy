import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { logger } from "./logger.js";
import { extractAll, createPackage, listPackage, readFileFromPackage } from "./asar.js";

export interface PatchResult {
  found: boolean;
  serverPaths: string[];
  patchedPaths: string[];
  asarPaths?: string[];
  patchedAsarPaths?: string[];
  skippedPaths?: string[];
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
    // POSIX locations (Linux / standalone CLI — never inside signed macOS .app bundles)
    const posixLocations = [
      "/usr/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server",
      "/usr/lib/node_modules/@getpaseo/server",
      "/usr/local/lib/node_modules/@getpaseo/cli/node_modules/@getpaseo/server",
      "/usr/local/lib/node_modules/@getpaseo/server",
    ];

    if (home) {
      posixLocations.push(
        path.join(home, ".local", "lib", "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
        path.join(home, ".local", "lib", "node_modules", "@getpaseo", "server"),
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

    // Inspect which paseo on POSIX
    try {
      const whichOut = execFileSync("which", ["paseo"], {
        encoding: "utf-8",
        timeout: 3000,
      }).trim();
      for (const line of whichOut.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
        let realLine = line;
        try {
          realLine = fs.realpathSync(line);
        } catch {}
        const dirs = [path.dirname(line), path.dirname(realLine)];
        for (const dir of dirs) {
          const checks = [
            path.join(dir, "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
            path.join(dir, "node_modules", "@getpaseo", "server"),
            path.join(path.dirname(dir), "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
            path.join(path.dirname(dir), "node_modules", "@getpaseo", "server"),
            path.join(path.dirname(path.dirname(dir)), "node_modules", "@getpaseo", "cli", "node_modules", "@getpaseo", "server"),
            path.join(path.dirname(path.dirname(dir)), "node_modules", "@getpaseo", "server"),
            path.join(dir, "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
            path.join(path.dirname(dir), "resources", "app.asar.unpacked", "node_modules", "@getpaseo", "server"),
          ];
          for (const c of checks) {
            if (fs.existsSync(c)) candidates.add(path.resolve(c));
          }
        }
      }
    } catch {}

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
  const seen = new Set<string>();
  for (const dir of candidates) {
    const key = process.platform === "win32" ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      process.platform === "darwin" &&
      dir.includes(".app/Contents/") &&
      process.env.PASEO_SERVER_PATH !== dir
    ) {
      continue;
    }
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
const BIN_CACHE_TTL_MS = 86400000; // 24 hours
let lastSuccessfulQuota = null;
let lastSuccessfulQuotaTime = 0;
const QUOTA_CACHE_TTL_MS = 60000; // 60 seconds

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
                path.join(localAppData, "agy", "bin", "agy.exe"),
                path.join(localAppData, "agy", "agy.exe"),
                path.join(home, ".agy", "bin", "agy.exe"),
                path.join(home, ".agy", "agy.exe"),
                path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
                path.join(localAppData, "Programs", "antigravity", "agy.exe"),
                path.join(localAppData, "Programs", "Antigravity", "agy.exe"),
                path.join(localAppData, "Programs", "agy", "bin", "agy.exe"),
                path.join(localAppData, "Programs", "agy", "agy.exe"),
                path.join(programFiles, "Antigravity", "bin", "agy.exe"),
                path.join(programFiles, "agy", "bin", "agy.exe"),
                path.join(programFilesX86, "Antigravity", "bin", "agy.exe"),
                path.join(programFilesX86, "agy", "bin", "agy.exe"),
                path.join(localAppData, "Google", "Antigravity", "agy.exe"),
                path.join(localAppData, "Google", "Antigravity", "bin", "agy.exe"),
                path.join(localAppData, "Google", "agy", "bin", "agy.exe"),
                path.join(localAppData, "Google", "agy", "agy.exe"),
                path.join(home, ".antigravity", "bin", "agy.exe"),
                path.join(home, ".antigravity", "agy.exe"),
                path.join(home, ".gemini", "antigravity-cli", "bin", "agy.exe"),
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
                    path.join(localAppData, "agy", "bin", "agy.cmd"),
                    path.join(localAppData, "agy", "agy.cmd"),
                    path.join(home, ".agy", "bin", "agy.cmd"),
                    path.join(appData, "npm", "agy.cmd"),
                    path.join(localAppData, "npm", "agy.cmd"),
                    path.join(home, ".local", "bin", "agy.cmd"),
                    path.join(home, ".antigravity", "bin", "agy.cmd"),
                    path.join(home, ".gemini", "antigravity-cli", "bin", "agy.cmd"),
                    path.join(localAppData, "agy", "bin", "agy.bat"),
                    path.join(localAppData, "agy", "agy.bat"),
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
            const posixCandidates = [
                path.join(home, ".local", "bin", "agy"),
                "/opt/homebrew/bin/agy",
                "/usr/local/bin/agy",
                "/usr/bin/agy",
                path.join(home, ".antigravity", "bin", "agy"),
                path.join(home, ".gemini", "antigravity-cli", "bin", "agy"),
            ];
            for (const cand of posixCandidates) {
                if (fs.existsSync(cand)) {
                    resolved = cand;
                    break;
                }
            }
            if (resolved === "agy") {
                try {
                    const out = execFileSync("which", ["agy"], { encoding: "utf-8", timeout: 2000 }).trim();
                    if (out && fs.existsSync(out)) resolved = out;
                } catch {}
            }
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
        const now = Date.now();
        if (lastSuccessfulQuota && (now - lastSuccessfulQuotaTime < QUOTA_CACHE_TTL_MS)) {
            return lastSuccessfulQuota;
        }

        try {
            const isWin = process.platform === "win32";
            const bin = resolveAgyBinary();
            this.binaryPath = bin;
            const isBatch = isWin && (!bin.toLowerCase().endsWith(".exe"));
            const home = os.homedir();
            const appData = process.env.APPDATA || (home ? path.join(home, "AppData", "Roaming") : "");
            const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
            const programFiles = process.env.ProgramFiles || "C:\\\\Program Files";
            const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\\\Program Files (x86)";

            const extraPaths = isWin ? [
                path.join(localAppData, "agy", "bin"),
                path.join(localAppData, "agy"),
                path.join(home, ".agy", "bin"),
                path.join(localAppData, "Programs", "Antigravity", "bin"),
                path.join(localAppData, "Programs", "antigravity"),
                path.join(localAppData, "Programs", "agy", "bin"),
                path.join(localAppData, "Google", "Antigravity", "bin"),
                path.join(localAppData, "Google", "agy", "bin"),
                path.join(home, ".antigravity", "bin"),
                path.join(home, ".gemini", "antigravity-cli", "bin"),
                path.join(home, ".local", "bin"),
                path.join(appData, "npm"),
                path.join(localAppData, "npm"),
                path.join(localAppData, "Microsoft", "WindowsApps"),
                path.join(programFiles, "nodejs"),
                path.join(programFilesX86, "nodejs"),
                path.join(programFiles, "Antigravity", "bin"),
                path.join(programFiles, "agy", "bin"),
                path.join(programFilesX86, "Antigravity", "bin"),
                path.join(programFilesX86, "agy", "bin"),
            ].filter(p => fs.existsSync(p)) : [
                home ? path.join(home, ".local", "bin") : "",
                "/opt/homebrew/bin",
                "/usr/local/bin",
                home ? path.join(home, ".antigravity", "bin") : "",
                home ? path.join(home, ".gemini", "antigravity-cli", "bin") : "",
            ].filter(p => p && fs.existsSync(p));

            const env = { ...process.env };
            if (extraPaths.length > 0) {
                const sep = path.delimiter;
                const currentPath = env.PATH || env.Path || "";
                const newPath = (currentPath ? currentPath + sep : "") + extraPaths.join(sep);
                env.PATH = newPath;
                if (isWin) env.Path = newPath;
            }

            let rawUsageOut = "";
            try {
                const usageRes = await execFileAsync(bin, ["--print-timeout", "24h", "--print", "/usage"], {
                    timeout: 30000,
                    env,
                    shell: isBatch,
                    windowsHide: true,
                });
                rawUsageOut = usageRes.stdout || usageRes.stderr || "";
            } catch (usageErr) {
                if (lastSuccessfulQuota) {
                    if (this.logger && typeof this.logger.warn === "function") {
                        this.logger.warn("Transient failure fetching agy /usage; returning cached quota", { error: usageErr.message });
                    }
                    return lastSuccessfulQuota;
                }
                const msg = usageErr instanceof Error ? usageErr.message : String(usageErr);
                return unavailableUsage({
                    providerId: this.providerId,
                    displayName: "Antigravity",
                    error: \`Quota fetch failed: \${msg}\`,
                });
            }

            let rawCreditsOut = "";
            try {
                const creditsRes = await execFileAsync(bin, ["--print-timeout", "24h", "--print", "/credits"], {
                    timeout: 6000,
                    env,
                    shell: isBatch,
                    windowsHide: true,
                });
                rawCreditsOut = creditsRes.stdout || creditsRes.stderr || "";
            } catch {}

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

                const m = trimmed.match(/^(.*?)\\s{2,}(.*?)\\s+(\\d+)%(?:\\s+(.*))?$/i);
                if (m) {
                    scope = m[1].trim();
                    limitType = m[2].trim();
                    remainingPct = parseInt(m[3], 10);
                    if (m[4]) {
                        try {
                            const d = new Date(m[4].trim());
                            resetsAt = isNaN(d.getTime()) ? null : d.toISOString();
                        } catch {
                            resetsAt = null;
                        }
                    }
                } else {
                    const parts = trimmed.split(/\\t+|\\s{2,}/).map(p => p.trim());
                    if (parts.length >= 3) {
                        scope = parts[0];
                        limitType = parts[1];
                        const remMatch = parts[2].match(/(\\d+)%/);
                        if (remMatch) remainingPct = parseInt(remMatch[1], 10);
                        if (parts[3]) {
                            try {
                                const d = new Date(parts[3]);
                                resetsAt = isNaN(d.getTime()) ? null : d.toISOString();
                            } catch {
                                resetsAt = null;
                            }
                        }
                    }
                }

                if (remainingPct !== null && !isNaN(remainingPct)) {
                    const usedPct = Math.max(0, Math.min(100, 100 - remainingPct));
                    const isFiveHour = /session|five\\s*hour|5-?hour|5h/i.test(limitType);
                    const isWeekly = /week|7-?day/i.test(limitType);
                    const isArgon = /argon/i.test(scope) || /argon/i.test(limitType);
                    const isClaude = /claude|gpt/i.test(scope);
                    const isGemini = (/gemini/i.test(scope) || !isClaude) && !isArgon;

                    let id = isFiveHour ? "session" : isWeekly ? "weekly" : "quota";
                    let label = isFiveHour ? "Session" : isWeekly ? "Weekly" : limitType.replace(/\\s+Remaining$/i, "");
                    if (isArgon) {
                        id = \`argon_\${id}\`;
                        label = \`Gemini 4 Argon \${isFiveHour ? "Session" : isWeekly ? "Weekly" : limitType.replace(/\\s+Remaining$/i, "").replace(/^Gemini 4 Argon\\s+/i, "")}\`;
                    } else if (!isGemini) {
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
                        isArgon,
                    });
                }
            }

            rawWindows.sort((a, b) => {
                const score = (w) => {
                    if (w.isGemini && !w.isArgon) return w.isFiveHour ? 1 : 2;
                    if (w.isArgon) return w.isFiveHour ? 3 : 4;
                    return w.isFiveHour ? 5 : 6;
                };
                return score(a) - score(b);
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

            const result = {
                providerId: this.providerId,
                displayName: "Antigravity",
                status: "available",
                planLabel: "Google Gemini",
                windows,
                balances,
                details: [],
                error: null,
            };

            lastSuccessfulQuota = result;
            lastSuccessfulQuotaTime = Date.now();
            return result;
        } catch (err) {
            if (lastSuccessfulQuota) return lastSuccessfulQuota;
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
 * Generates the TypeScript source for the Paseo 0.11+ Plugin Usage Source.
 * This integrates Antigravity quota and balance metrics into Paseo 0.11+'s
 * new Plugin UsageSource architecture (Settings -> Usage).
 */
export function generateAntigravityPluginUsageTs(): string {
  return `import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";

let cachedAgyBin = null;
let lastAgyBinCheck = 0;
const RESOLVE_TTL_MS = 30000;
let lastSuccessfulPluginQuota = null;
let lastSuccessfulPluginQuotaTime = 0;
const PLUGIN_QUOTA_CACHE_TTL_MS = 60000;

function resolveAgyBinary() {
    const now = Date.now();
    if (cachedAgyBin && (now - lastAgyBinCheck) < RESOLVE_TTL_MS) {
        return cachedAgyBin;
    }

    if (process.env.AGY_BIN_PATH && fs.existsSync(process.env.AGY_BIN_PATH)) {
        cachedAgyBin = process.env.AGY_BIN_PATH;
        lastAgyBinCheck = now;
        return cachedAgyBin;
    }

    const home = os.homedir();
    const isWin = process.platform === "win32";

    if (isWin) {
        const localAppData = process.env.LOCALAPPDATA || (home ? path.join(home, "AppData", "Local") : "");
        const programFiles = process.env.ProgramFiles || "C:\\\\Program Files";
        const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\\\Program Files (x86)";

        const winCandidates = [
            path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe"),
            path.join(localAppData, "Programs", "antigravity", "bin", "agy.exe"),
            path.join(localAppData, "Programs", "Antigravity", "agy.exe"),
            path.join(localAppData, "Programs", "antigravity", "agy.exe"),
            path.join(localAppData, "antigravity", "agy.exe"),
            path.join(programFiles, "Antigravity", "bin", "agy.exe"),
            path.join(programFiles, "antigravity", "bin", "agy.exe"),
            path.join(programFiles, "Antigravity", "agy.exe"),
            path.join(programFiles, "antigravity", "agy.exe"),
            path.join(programFilesX86, "Antigravity", "agy.exe"),
            path.join(localAppData, "Microsoft", "WindowsApps", "agy.exe"),
        ];

        for (const cand of winCandidates) {
            if (cand && fs.existsSync(cand)) {
                cachedAgyBin = cand;
                lastAgyBinCheck = now;
                return cand;
            }
        }

        try {
            const out = execFileSync("where.exe", ["agy"], {
                encoding: "utf-8",
                timeout: 3000,
                windowsHide: true,
            });
            const lines = out.split(/\\r?\\n/).map(l => l.trim()).filter(Boolean);
            const exeMatch = lines.find(l => /\\.exe$/i.test(l) && fs.existsSync(l));
            if (exeMatch) {
                cachedAgyBin = exeMatch;
                lastAgyBinCheck = now;
                return exeMatch;
            }
            const scriptMatch = lines.find(l => /\\.(cmd|bat)$/i.test(l) && fs.existsSync(l));
            if (scriptMatch) {
                cachedAgyBin = scriptMatch;
                lastAgyBinCheck = now;
                return scriptMatch;
            }
            if (lines.length > 0 && fs.existsSync(lines[0])) {
                cachedAgyBin = lines[0];
                lastAgyBinCheck = now;
                return lines[0];
            }
        } catch {}

        cachedAgyBin = "agy.exe";
        lastAgyBinCheck = now;
        return cachedAgyBin;
    } else {
        const posixCandidates = [
            path.join(home, ".local", "bin", "agy"),
            "/opt/homebrew/bin/agy",
            "/usr/local/bin/agy",
            "/usr/bin/agy",
            path.join(home, ".antigravity", "bin", "agy"),
            path.join(home, ".gemini", "antigravity-cli", "bin", "agy"),
        ];
        for (const cand of posixCandidates) {
            if (fs.existsSync(cand)) {
                cachedAgyBin = cand;
                lastAgyBinCheck = now;
                return cand;
            }
        }
        try {
            const out = execFileSync("which", ["agy"], {
                encoding: "utf-8",
                timeout: 3000,
            }).trim();
            if (out && fs.existsSync(out)) {
                cachedAgyBin = out;
                lastAgyBinCheck = now;
                return out;
            }
        } catch {}

        cachedAgyBin = "agy";
        lastAgyBinCheck = now;
        return cachedAgyBin;
    }
}

function toneFromUsedPct(usedPct) {
    if (usedPct >= 90) return "danger";
    if (usedPct >= 75) return "warning";
    return "ok";
}

function isStandaloneTelemetryPluginEnabled() {
    try {
        let paseoHome = process.env.PASEO_HOME;
        if (!paseoHome && Array.isArray(process.argv)) {
            const homeIdx = process.argv.indexOf("--home");
            if (homeIdx !== -1 && process.argv[homeIdx + 1]) {
                paseoHome = process.argv[homeIdx + 1];
            }
        }
        paseoHome = paseoHome || path.join(os.homedir(), ".paseo");
        const cfgPath = path.join(paseoHome, "config.json");
        if (!fs.existsSync(cfgPath)) return false;
        const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf-8"));
        if (cfg && cfg.pluginsEnabled === false) return false;
        const entry = cfg && cfg.plugins && cfg.plugins["antigravity-telemetry"];
        return Boolean(entry && entry.enabled !== false);
    } catch {
        return false;
    }
}

export async function fetchAntigravityUsage() {
    const now = Date.now();
    if (lastSuccessfulPluginQuota && (now - lastSuccessfulPluginQuotaTime < PLUGIN_QUOTA_CACHE_TTL_MS)) {
        return lastSuccessfulPluginQuota;
    }

    try {
        const bin = resolveAgyBinary();
        const isWin = process.platform === "win32";
        const isBatch = isWin && /\\.(cmd|bat)$/i.test(bin);
        const home = os.homedir();
        const extraPosixPaths = !isWin ? [
            home ? path.join(home, ".local", "bin") : "",
            "/opt/homebrew/bin",
            "/usr/local/bin",
            home ? path.join(home, ".antigravity", "bin") : "",
            home ? path.join(home, ".gemini", "antigravity-cli", "bin") : "",
        ].filter(p => p && fs.existsSync(p)) : [];
        const env = { ...process.env };
        if (extraPosixPaths.length > 0) {
            const sep = path.delimiter;
            env.PATH = (env.PATH ? env.PATH + sep : "") + extraPosixPaths.join(sep);
        }

        let usageOut = "";
        try {
            usageOut = execFileSync(bin, ["--print-timeout", "24h", "--print", "/usage"], {
                encoding: "utf-8",
                timeout: 30000,
                env,
                windowsHide: true,
                shell: isBatch,
            });
        } catch (usageErr) {
            if (lastSuccessfulPluginQuota) return lastSuccessfulPluginQuota;
            throw usageErr;
        }

        let creditsOut = "";
        try {
            creditsOut = execFileSync(bin, ["--print-timeout", "24h", "--print", "/credits"], {
                encoding: "utf-8",
                timeout: 6000,
                env,
                windowsHide: true,
                shell: isBatch,
            });
        } catch {}

        const normalizedUsage = usageOut.replace(/\\r\\n/g, "\\n");
        const lines = normalizedUsage.split("\\n");
        const rawWindows = [];
        let currentModel = "";

        for (const rawLine of lines) {
            const line = rawLine.trim();
            if (!line || line.toLowerCase().startsWith("quota:")) continue;

            let scope = currentModel;
            let limitType = "";
            let remainingPct = null;
            let resetsAt = null;

            // Format 1: Table format e.g. "Gemini Models   Weekly Limit Remaining   56%   2026-10-14 04:37 UTC"
            const m = line.match(/^(.*?)\\s{2,}(.*?)\\s+(\\d+)%(?:\\s+(.*))?$/i);
            if (m) {
                scope = m[1].trim();
                limitType = m[2].trim();
                remainingPct = parseInt(m[3], 10);
                if (m[4]) {
                    try {
                        const d = new Date(m[4].trim());
                        resetsAt = isNaN(d.getTime()) ? null : d.toISOString();
                    } catch {}
                }
            } else {
                // Format 2: Tab / multi-space separated
                const parts = line.split(/\\t+|\\s{2,}/).map(p => p.trim());
                if (parts.length >= 3) {
                    scope = parts[0];
                    limitType = parts[1];
                    const remMatch = parts[2].match(/(\\d+)%/);
                    if (remMatch) remainingPct = parseInt(remMatch[1], 10);
                    if (parts[3]) {
                        try {
                            const d = new Date(parts[3]);
                            resetsAt = isNaN(d.getTime()) ? null : d.toISOString();
                        } catch {}
                    }
                } else if (line.endsWith(":") && !line.includes("%")) {
                    currentModel = line.slice(0, -1).trim();
                    continue;
                } else {
                    // Format 3: Colon format e.g. "Session: 20% used (resets in 2h)"
                    const colonMatch = line.match(/^([A-Za-z0-9\\s_-]+):\\s*(\\d+)%\\s*(?:used)?(?:\\s*\\((?:resets?\\s+in\\s+)?([^)]+)\\))?/i);
                    if (colonMatch) {
                        limitType = colonMatch[1].trim();
                        const usedVal = parseInt(colonMatch[2], 10);
                        remainingPct = Math.max(0, 100 - usedVal);
                        const resetStr = colonMatch[3] ? colonMatch[3].trim() : null;
                        if (resetStr) {
                            const durMatch = resetStr.match(/(?:(\\d+)h)?\\s*(?:(\\d+)m)?/i);
                            if (durMatch && (durMatch[1] || durMatch[2])) {
                                const h = parseInt(durMatch[1] || "0", 10);
                                const m = parseInt(durMatch[2] || "0", 10);
                                resetsAt = new Date(Date.now() + (h * 3600 + m * 60) * 1000).toISOString();
                            } else {
                                const parsed = Date.parse(resetStr);
                                if (!isNaN(parsed)) resetsAt = new Date(parsed).toISOString();
                            }
                        }
                    }
                }
            }

            if (remainingPct !== null && !isNaN(remainingPct)) {
                const usedPct = Math.max(0, Math.min(100, 100 - remainingPct));
                const isFiveHour = /session|five\\s*hour|5-?hour|5h/i.test(limitType);
                const isWeekly = /week|7-?day/i.test(limitType);
                const isArgon = /argon/i.test(scope) || /argon/i.test(limitType);
                const isClaude = /claude|gpt/i.test(scope);
                const isGemini = (/gemini/i.test(scope) || !isClaude) && !isArgon;

                let id = isFiveHour ? "session" : isWeekly ? "weekly" : "quota";
                let label = isFiveHour ? "Session" : isWeekly ? "Weekly" : limitType.replace(/\\s+Remaining$/i, "");
                if (isArgon) {
                    id = \`argon_\${id}\`;
                    label = \`Gemini 4 Argon \${isFiveHour ? "Session" : isWeekly ? "Weekly" : limitType.replace(/\\s+Remaining$/i, "").replace(/^Gemini 4 Argon\\s+/i, "")}\`;
                } else if (!isGemini) {
                    id = \`claude_\${id}\`;
                    label = \`Claude \${label}\`;
                }

                rawWindows.push({
                    id,
                    label,
                    shortLabel: isFiveHour ? "5h" : isWeekly ? "wk" : isArgon ? "Argon" : "",
                    summary: true,
                    usedPct,
                    remainingPct,
                    resetsAt,
                    tone: toneFromUsedPct(usedPct),
                    isFiveHour,
                    isGemini,
                    isArgon,
                });
            }
        }

        rawWindows.sort((a, b) => {
            const score = (w) => {
                if (w.isGemini && !w.isArgon) return w.isFiveHour ? 1 : 2;
                if (w.isArgon) return w.isFiveHour ? 3 : 4;
                return w.isFiveHour ? 5 : 6;
            };
            return score(a) - score(b);
        });

        const windows = rawWindows.map(w => ({
            id: w.id,
            label: w.label,
            shortLabel: w.shortLabel,
            summary: w.summary,
            usedPct: w.usedPct,
            remainingPct: w.remainingPct,
            resetsAt: w.resetsAt,
            tone: w.tone,
        }));

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

        const result = {
            status: "available",
            planLabel: "Google Gemini",
            windows,
            balances,
            details: [],
        };
        lastSuccessfulPluginQuota = result;
        lastSuccessfulPluginQuotaTime = Date.now();
        return result;
    } catch (err) {
        if (lastSuccessfulPluginQuota) return lastSuccessfulPluginQuota;
        return {
            status: "error",
            error: err instanceof Error ? err.message : String(err),
        };
    }
}

export function registerAntigravityUsageSource(server) {
    if (!server || typeof server.registerUsageSource !== "function") return;
    if (isStandaloneTelemetryPluginEnabled()) return;
    try {
        server.registerUsageSource({
            id: "antigravity",
            label: "Antigravity",
            icon: "icon.svg",
            input: z.object({}).passthrough(),
            discover: async (scope) => {
                if (scope && scope.kind === "session" && scope.provider && scope.provider !== "antigravity" && scope.provider !== "acp") {
                    return [];
                }
                return [{ key: "default", label: "Antigravity", input: {} }];
            },
            fetch: async () => {
                return fetchAntigravityUsage();
            },
        });
    } catch (err) {
        console.warn("[antigravity-provider] Failed to register usage source:", err);
    }
}
`;
}

/**
 * Patches a Paseo server installation directory to enable Antigravity:
 * 1. For Paseo 0.11+: patches builtin-plugins/antigravity-provider with usage source
 * 2. For Paseo <= 0.10: patches quota-fetcher/manifest.js and writes providers/antigravity.js
 * 3. Patches acp-agent.js to map context window tokens and emit usage updates
 */
export function patchPaseoServer(serverDir: string): { success: boolean; changes: string[]; error?: string } {
  const changes: string[] = [];
  try {
    // 1. Check for Paseo 0.11+ builtin-plugins/antigravity-provider
    const pluginDirCandidates = [
      path.join(serverDir, "dist", "server", "builtin-plugins", "antigravity-provider"),
      path.join(serverDir, "dist", "builtin-plugins", "antigravity-provider"),
      path.join(serverDir, "builtin-plugins", "antigravity-provider"),
    ];
    let pluginDir = pluginDirCandidates.find((d) => fs.existsSync(d));

    if (!pluginDir && fs.existsSync(path.join(serverDir, "dist"))) {
      const findPlugin = (dir: string, depth = 0): string | null => {
        if (depth > 5) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && e.name !== "node_modules") {
              if (e.name === "antigravity-provider") return full;
              const found = findPlugin(full, depth + 1);
              if (found) return found;
            }
          }
        } catch {}
        return null;
      };
      pluginDir = findPlugin(path.join(serverDir, "dist")) || undefined;
    }

    if (pluginDir) {
      const serverSubdir = path.join(pluginDir, "server");
      if (!fs.existsSync(serverSubdir)) {
        fs.mkdirSync(serverSubdir, { recursive: true });
      }

      // Write / update usage.ts
      const usageTsPath = path.join(serverSubdir, "usage.ts");
      fs.writeFileSync(usageTsPath, generateAntigravityPluginUsageTs(), "utf-8");
      changes.push(`Created/Updated ${usageTsPath}`);

      // Locate index.server.ts and/or index.server.js
      const indexCandidates = [
        path.join(pluginDir, "index.server.ts"),
        path.join(pluginDir, "index.server.js"),
      ].filter((f) => fs.existsSync(f));

      for (const indexFile of indexCandidates) {
        let indexCode = fs.readFileSync(indexFile, "utf-8");
        let indexModified = false;

        if (!indexCode.includes("registerAntigravityUsageSource")) {
          // Add import
          if (!indexCode.includes('from "./server/usage.js"')) {
            indexCode = `import { registerAntigravityUsageSource } from "./server/usage.js";\n` + indexCode;
            indexModified = true;
          }

          // Inject registration call into contribute function
          if (!indexCode.includes("registerAntigravityUsageSource(server)")) {
            if (/return\s*\(\)\s*=>/.test(indexCode)) {
              indexCode = indexCode.replace(
                /return\s*\(\)\s*=>/,
                "server.registerUsageSource ? registerAntigravityUsageSource(server) : null;\n  return () =>"
              );
              indexModified = true;
            } else {
              const lastBraceIndex = indexCode.lastIndexOf("}");
              if (lastBraceIndex !== -1) {
                indexCode =
                  indexCode.slice(0, lastBraceIndex) +
                  "  server.registerUsageSource ? registerAntigravityUsageSource(server) : null;\n" +
                  indexCode.slice(lastBraceIndex);
                indexModified = true;
              }
            }
          }
        }

        if (indexModified) {
          fs.writeFileSync(indexFile, indexCode, "utf-8");
          changes.push(`Patched ${indexFile} with registerAntigravityUsageSource`);
        }
      }
    }

    // 2. Check for Paseo <= 0.10 legacy quota-fetcher/manifest.js
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

    // 3. Locate acp-agent.js
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
      if (!acpCode.includes("contextWindowMaxTokens: usage.contextWindowMaxTokens") || !acpCode.includes("Math.min(usedTokens, maxTokens)")) {
        const oldMapRegex = /export\s+function\s+mapACPUsage\s*\([^)]*\)\s*\{[\s\S]*?return\s*\{[\s\S]*?\};\s*\}/m;
        const newMap = `export function mapACPUsage(usage) {
    if (!usage) {
        return undefined;
    }
    const maxTokens = usage.contextWindowMaxTokens ?? usage.size ?? undefined;
    let usedTokens = usage.contextWindowUsedTokens ?? usage.used ?? undefined;
    if (typeof usedTokens === "number" && typeof maxTokens === "number" && maxTokens > 0) {
        if (usedTokens > maxTokens) {
            usedTokens = Math.min(usedTokens, maxTokens);
        }
    }
    return {
        inputTokens: usage.inputTokens ?? undefined,
        outputTokens: usage.outputTokens ?? undefined,
        cachedInputTokens: usage.cachedReadTokens ?? usage.cachedInputTokens ?? undefined,
        totalCostUsd: usage.totalCostUsd ?? (usage.cost?.amount !== undefined ? Number(usage.cost.amount) : undefined),
        contextWindowMaxTokens: usage.contextWindowMaxTokens ?? usage.size ?? undefined,
        contextWindowUsedTokens: usedTokens,
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
      const methodMatch = acpCode.match(/(?:^|\n)([ \t]*)handleUsageUpdate\s*\([^)]*\)\s*\{/);
      if (methodMatch && methodMatch.index !== undefined) {
        const startIdx = methodMatch.index + (methodMatch[0].startsWith("\n") ? 1 : 0);
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
            const currentMethodBody = acpCode.slice(startIdx, i);
            const needsPatch = !currentMethodBody.includes("this.currentTurnUsage =") || currentMethodBody.includes("this.notifySubscribers");
            if (needsPatch) {
              const indent = methodMatch[1] || "    ";
              const newHandler = `${indent}handleUsageUpdate(update) {
${indent}    if (!update) return;
${indent}    const usage = mapACPUsage(update);
${indent}    if (usage) {
${indent}        this.currentTurnUsage = { ...this.currentTurnUsage, ...usage };
${indent}        const event = {
${indent}            type: "usage_updated",
${indent}            provider: this.provider,
${indent}            usage: this.currentTurnUsage,
${indent}            ...(this.activeForegroundTurnId ? { turnId: this.activeForegroundTurnId } : {}),
${indent}        };
${indent}        if (typeof this.pushEvent === "function") {
${indent}            this.pushEvent(event);
${indent}        } else if (typeof this.deliverTranslatedEvents === "function") {
${indent}            this.deliverTranslatedEvents([event]);
${indent}        }
${indent}    }
${indent}}`;
              acpCode = acpCode.slice(0, startIdx) + newHandler + acpCode.slice(i);
              acpModified = true;
            }
          }
        }
      }

      // Patch usageSession() in ACPAgentSession for Paseo 0.11+ usage reporting
      if (!acpCode.includes("usageSession()")) {
        const constructorEndMatch = acpCode.match(/(?:^|\n)([ \t]*)this\.extensionCommandsParser\s*=[^;\n]*;[ \t]*\r?\n([ \t]*)\}/);
        if (constructorEndMatch && constructorEndMatch.index !== undefined) {
          const indent = constructorEndMatch[1] || "        ";
          const braceIndent = constructorEndMatch[2] || "    ";
          const usageSnippet = `this.usageSessionKey = typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2);
${braceIndent}}
${braceIndent}usageSession() {
${braceIndent}    if (this.closed)
${braceIndent}        return null;
${braceIndent}    if (!this.usageSessionKey) {
${braceIndent}        this.usageSessionKey = typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2);
${braceIndent}    }
${braceIndent}    return {
${braceIndent}        provider: this.provider,
${braceIndent}        model: this.currentModel ?? this.config?.model,
${braceIndent}        env: (this.launchEnv && typeof this.launchEnv === "object") ? this.launchEnv : {},
${braceIndent}        sessionKey: this.usageSessionKey,
${braceIndent}    };
${braceIndent}}`;
          acpCode = acpCode.replace(
            /(?:^|\n)([ \t]*)this\.extensionCommandsParser\s*=[^;\n]*;[ \t]*\r?\n([ \t]*)\}/,
            (match, ind1) => `\n${ind1}this.extensionCommandsParser = options.extensionCommandsParser;\n${ind1}${usageSnippet}`
          );
          acpModified = true;
        } else {
          const sessionClassMatch = acpCode.match(/(?:export\s+)?class\s+ACPAgentSession\b[^{]*\{/);
          if (sessionClassMatch && sessionClassMatch.index !== undefined) {
            const insertPos = sessionClassMatch.index + sessionClassMatch[0].length;
            const usageSnippet = `\n    usageSession() {
        if (this.closed)
            return null;
        if (!this.usageSessionKey) {
            this.usageSessionKey = typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2);
        }
        return {
            provider: this.provider,
            model: this.currentModel ?? this.config?.model,
            env: (this.launchEnv && typeof this.launchEnv === "object") ? this.launchEnv : {},
            sessionKey: this.usageSessionKey,
        };
    }`;
            acpCode = acpCode.slice(0, insertPos) + usageSnippet + acpCode.slice(insertPos);
            acpModified = true;
          }
        }
      } else if (acpCode.includes("!this.usageProvider")) {
        // Paseo 0.13.0+ defines usageSession() with `if (this.closed || !this.usageProvider) return null;`
        // while GenericACPAgentClient (`extends: "acp"`) leaves `this.usageProvider = undefined`.
        const nextCode = acpCode
          .replace(/if\s*\(\s*this\.closed\s*\|\|\s*!this\.usageProvider\s*\)/g, "if (this.closed)")
          .replace(/provider:\s*this\.usageProvider\b/g, "provider: this.usageProvider ?? this.provider");
        if (nextCode !== acpCode) {
          acpCode = nextCode;
          acpModified = true;
        }
      }

      // Patch handlePromptResponse so response.usage merges defined fields instead of wiping
      // totalCostUsd / contextWindowMaxTokens / contextWindowUsedTokens from this.currentTurnUsage
      const promptRespAssignRegex =
        /([ \t]*)this\.currentTurnUsage\s*=\s*mapACPUsage\(response\.usage\)\s*\?\?\s*this\.currentTurnUsage;/;
      if (promptRespAssignRegex.test(acpCode) && !acpCode.includes("_mappedRespUsage")) {
        acpCode = acpCode.replace(
          promptRespAssignRegex,
          (_m, ind) =>
            `${ind}const _mappedRespUsage = mapACPUsage(response.usage);\n` +
            `${ind}if (_mappedRespUsage) {\n` +
            `${ind}    this.currentTurnUsage = {\n` +
            `${ind}        ...this.currentTurnUsage,\n` +
            `${ind}        ...Object.fromEntries(Object.entries(_mappedRespUsage).filter(([, v]) => v !== undefined)),\n` +
            `${ind}    };\n` +
            `${ind}}`
        );
        acpModified = true;
      }

      // Patch subscribe(callback) so any usage_update received during newSession/loadSession
      // (before subscribers attach, including history resumes) is replayed immediately
      const subscribeMethodMatch = acpCode.match(/subscribe\s*\([^)]*\)\s*\{[\s\S]*?\n\s*\}/);
      if (
        subscribeMethodMatch &&
        acpCode.includes('type: "thread_started"') &&
        !subscribeMethodMatch[0].includes("usage_updated")
      ) {
        acpCode = acpCode.replace(
          /(\bcallback\(\{\s*type:\s*"thread_started"[\s\S]*?\}\);\s*\})/,
          `$1\n        if (this.currentTurnUsage) {\n            callback({\n                type: "usage_updated",\n                provider: this.provider,\n                usage: this.currentTurnUsage,\n            });\n        }`
        );
        acpModified = true;
      }

      // Patch mapPermissionRequest for native QuestionFormCard support in Paseo UI
      if (!acpCode.includes("snapshot?.kind === \"question\" || params?.kind === \"question\"")) {
        const oldMapPermRegex = /function\s+mapPermissionRequest\s*\([^)]*\)\s*\{[\s\S]*?const\s+kind\s*=\s*snapshot\.kind\s*===\s*"switch_mode"\s*\?\s*"mode"\s*:\s*"tool";/m;
        const newMapPerm = `function mapPermissionRequest(provider, requestId, params, snapshot) {
    if (snapshot?.kind === "question" || params?.kind === "question" || (params?.questions && Array.isArray(params.questions)) || (snapshot?.rawInput?.questions && Array.isArray(snapshot?.rawInput?.questions))) {
        const rawQ = params.questions || snapshot?.rawInput?.questions || [];
        const questions = rawQ.map((q, idx) => ({
            header: q.header || q.title || ("Question " + (idx + 1)),
            question: q.question || q.prompt || "Escolha uma opção:",
            options: (q.options || []).map((opt) => typeof opt === "string" ? {
                label: opt.replace(/^\\(Recommended\\)\\s*/i, "").replace(/^\\(Recomendado\\)\\s*/i, "").trim(),
                description: (opt.includes("(Recommended)") || opt.includes("(Recomendado)")) ? "Recomendado" : undefined
            } : { label: opt.label || String(opt), description: opt.description }),
            multiSelect: q.multiSelect === true || q.is_multi_select === true || q.multiple === true,
            allowOther: true,
            allowEmpty: false,
        }));
        return {
            id: requestId,
            provider,
            name: "question",
            kind: "question",
            title: params.toolCall?.title ?? snapshot?.title ?? "Pergunta do Assistente",
            input: { questions },
            actions: (params.options || []).map((option) => ({
                id: option.optionId,
                label: option.name,
                behavior: option.kind.startsWith("allow") ? "allow" : "deny",
            })),
            metadata: {
                toolCallId: params.toolCall?.toolCallId,
                rawRequest: params,
                options: params.options,
            },
        };
    }
    const kind = snapshot.kind === "switch_mode" ? "mode" : "tool";`;
        if (oldMapPermRegex.test(acpCode)) {
          acpCode = acpCode.replace(oldMapPermRegex, newMapPerm);
          acpModified = true;
          changes.push(`Patched ${acpFile} for interactive QuestionFormCard support`);
        }
      }

      // Patch respondToPermission for QuestionFormCard updatedInput.answers
      if (!acpCode.includes("response.updatedInput?.answers")) {
        const oldRespondMatch = acpCode.match(/this\.pendingPermissions\.delete\(requestId\);[\s\S]*?pending\.resolve\([\s\S]*?\);\s*\r?\n\s*this\.pushEvent/m);
        if (oldRespondMatch) {
          const newRespond = `this.pendingPermissions.delete(requestId);
        const outcome = response.updatedInput?.answers
            ? { outcome: "selected", optionId: selectedOption?.optionId || "form_submit", _meta: { answers: response.updatedInput.answers } }
            : (selectedOption ? { outcome: { outcome: "selected", optionId: selectedOption.optionId } } : { outcome: { outcome: "cancelled" } });
        pending.resolve(response.updatedInput?.answers ? { outcome } : (selectedOption ? { outcome: { outcome: "selected", optionId: selectedOption.optionId } } : { outcome: { outcome: "cancelled" } }));
        this.pushEvent`;
          acpCode = acpCode.replace(oldRespondMatch[0], newRespond);
          acpModified = true;
        }
      }

      if (acpModified) {
        fs.writeFileSync(acpFile, acpCode, "utf-8");
        changes.push(`Patched ${acpFile} for context-window token telemetry and usage updates`);
      }
    }

    // 4. Locate and patch plugin-provider.js (if present) for Paseo 0.11+
    const pluginProviderCandidates = [
      path.join(serverDir, "dist", "server", "server", "agent", "plugin-provider.js"),
      path.join(serverDir, "dist", "server", "agent", "plugin-provider.js"),
      path.join(serverDir, "dist", "agent", "plugin-provider.js"),
    ];
    let pluginProviderFile = pluginProviderCandidates.find((f) => fs.existsSync(f));
    if (!pluginProviderFile && fs.existsSync(path.join(serverDir, "dist"))) {
      const findPluginProvider = (dir: string, depth = 0): string | null => {
        if (depth > 5) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && e.name !== "node_modules") {
              const found = findPluginProvider(full, depth + 1);
              if (found) return found;
            } else if (e.isFile() && e.name === "plugin-provider.js") {
              return full;
            }
          }
        } catch {}
        return null;
      };
      pluginProviderFile = findPluginProvider(path.join(serverDir, "dist")) || undefined;
    }

    if (pluginProviderFile) {
      let ppCode = fs.readFileSync(pluginProviderFile, "utf-8");
      if (!ppCode.includes("usageSession()")) {
        const ppClassMatch = ppCode.match(/(?:export\s+)?class\s+PluginAgentSession\b[^{]*\{/);
        if (ppClassMatch && ppClassMatch.index !== undefined) {
          const insertPos = ppClassMatch.index + ppClassMatch[0].length;
          const ppUsage = `\n    usageSession() {
        if (this.closed)
            return null;
        if (!this.usageSessionKey) {
            this.usageSessionKey = typeof randomUUID === "function" ? randomUUID() : Math.random().toString(36).slice(2);
        }
        return {
            provider: this.provider,
            model: this.bridge?.config?.model,
            env: (this.bridge?.launch?.env && typeof this.bridge?.launch?.env === "object") ? this.bridge.launch.env : {},
            sessionKey: this.usageSessionKey,
        };
    }`;
          ppCode = ppCode.slice(0, insertPos) + ppUsage + ppCode.slice(insertPos);
          fs.writeFileSync(pluginProviderFile, ppCode, "utf-8");
          changes.push(`Patched ${pluginProviderFile} with usageSession for plugin provider sessions`);
        }
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

  const result: string[] = [];
  const seen = new Set<string>();
  for (const loc of candidates) {
    const key = process.platform === "win32" ? loc.toLowerCase() : loc;
    if (!seen.has(key)) {
      seen.add(key);
      result.push(loc);
    }
  }
  return result;
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

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-asar-extract-"));
    const { unpackedPaths, originalHeader } = extractAll(asarPath, tempDir);

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

    // Create backup if not already present (or refresh if backup is from a stale Paseo version).
    // On macOS, never write backup inside .app bundle (e.g. app.asar.bak) because it breaks code signing seals.
    const currentVersion = resolveTargetPaseoVersion(asarPath);
    let backupPath: string;
    if (process.platform === "darwin" && asarPath.includes(".app")) {
      const backupDir = path.join(os.homedir(), ".paseo", "backups");
      if (!fs.existsSync(backupDir)) {
        fs.mkdirSync(backupDir, { recursive: true });
      }
      backupPath = path.join(backupDir, "app.asar.bak");
      if (currentVersion) {
        const versionedBackup = path.join(backupDir, `app.asar.${currentVersion}.bak`);
        if (!fs.existsSync(versionedBackup)) {
          try {
            fs.copyFileSync(asarPath, versionedBackup);
            changes.push(`Backed up versioned asar to ${versionedBackup}`);
          } catch {}
        }
      }
      // Clean up any orphan backup inside the .app bundle from previous runs
      const orphanBak = `${asarPath}.bak`;
      if (fs.existsSync(orphanBak)) {
        try {
          fs.unlinkSync(orphanBak);
        } catch {}
      }
    } else {
      backupPath = `${asarPath}.bak`;
    }

    const existingBackupVer = fs.existsSync(backupPath) ? resolveAsarArchiveVersion(backupPath) : null;
    const needsFreshBackup =
      !fs.existsSync(backupPath) ||
      Boolean(currentVersion && existingBackupVer && currentVersion !== existingBackupVer);

    if (needsFreshBackup) {
      try {
        fs.copyFileSync(asarPath, backupPath);
        changes.push(`Backed up original asar to ${backupPath}`);
      } catch (backupErr) {
        logger.warn(`Could not create asar backup at ${backupPath}`, { error: String(backupErr) });
      }
    }

    tempAsar = path.join(os.tmpdir(), `app-${Date.now()}.asar`);
    await createPackage(tempDir, tempAsar, { unpackedPaths, originalHeader });

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

    // On macOS, re-sign application bundle if inside an .app directory to satisfy Gatekeeper
    if (process.platform === "darwin" && asarPath.includes(".app")) {
      const appIndex = asarPath.indexOf(".app");
      const appBundlePath = asarPath.slice(0, appIndex + 4);
      try {
        execFileSync("codesign", ["--force", "--deep", "--sign", "-", appBundlePath], {
          stdio: "ignore",
          timeout: 15000,
        });
        changes.push(`Re-signed macOS bundle at ${appBundlePath}`);
        try {
          execFileSync("xattr", ["-cr", appBundlePath], {
            stdio: "ignore",
            timeout: 10000,
          });
          changes.push(`Cleared quarantine extended attributes at ${appBundlePath}`);
        } catch {}
      } catch (signErr) {
        logger.warn(`Could not re-sign ${appBundlePath}`, { error: String(signErr) });
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
  forceMacosApp?: boolean;
}): Promise<PatchResult> {
  const rawServerPaths = options?.targetPaths || findPaseoServerInstallations();
  const rawAsarPaths = options?.targetAsarPaths || findPaseoAsarPaths();
  const serverPaths: string[] = [];
  const asarPaths: string[] = [];
  const skippedPaths: string[] = [];
  const patchedPaths: string[] = [];
  const patchedAsarPaths: string[] = [];
  const errors: string[] = [];

  for (const sPath of rawServerPaths) {
    if (process.platform === "darwin" && sPath.includes(".app") && !options?.forceMacosApp) {
      skippedPaths.push(sPath);
      if (options?.verbose) {
        logger.info(`[macOS] Skipping server path inside .app bundle to preserve Apple signature: ${sPath}`);
      }
      continue;
    }
    serverPaths.push(sPath);
  }

  for (const aPath of rawAsarPaths) {
    if (process.platform === "darwin" && aPath.includes(".app") && !options?.forceMacosApp) {
      skippedPaths.push(aPath);
      if (options?.verbose) {
        logger.info(`[macOS] Skipping app.asar inside .app bundle to preserve Apple signature: ${aPath}`);
      }
      continue;
    }
    asarPaths.push(aPath);
  }

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
    found: serverPaths.length > 0 || asarPaths.length > 0 || skippedPaths.length > 0,
    serverPaths,
    patchedPaths,
    asarPaths,
    patchedAsarPaths,
    skippedPaths,
    errors,
  };
}

/**
 * Reads the Paseo version embedded inside an ASAR archive's package.json.
 */
export function resolveAsarArchiveVersion(archivePath: string): string | null {
  if (!fs.existsSync(archivePath)) return null;
  for (const rel of [
    "package.json",
    "node_modules/@getpaseo/server/package.json",
    "dist/node_modules/@getpaseo/server/package.json",
  ]) {
    const raw = readFileFromPackage(archivePath, rel);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw) as { version?: unknown };
      if (typeof parsed.version === "string" && parsed.version.trim()) {
        return parsed.version.trim();
      }
    } catch {}
  }
  return null;
}

/**
 * Resolves the authoritative Paseo version of a target app.asar installation,
 * preferring macOS bundle Info.plist (CFBundleShortVersionString) when inside an .app bundle.
 */
export function resolveTargetPaseoVersion(asarPath: string): string | null {
  if (asarPath.includes(".app")) {
    const appIndex = asarPath.indexOf(".app");
    const appBundlePath = asarPath.slice(0, appIndex + 4);
    const infoPlistPath = path.join(appBundlePath, "Contents", "Info.plist");
    if (fs.existsSync(infoPlistPath)) {
      try {
        const plist = fs.readFileSync(infoPlistPath, "utf-8");
        const m = plist.match(
          /<key>\s*CFBundleShortVersionString\s*<\/key>\s*<string>\s*([^<\s]+)\s*<\/string>/i
        );
        if (m && m[1]) {
          return m[1].trim();
        }
      } catch {}
    }
  }
  return resolveAsarArchiveVersion(asarPath);
}

/**
 * Restores original unpatched Paseo files from backup (.bak) archives,
 * enforcing strict version matching so an older backup can never downgrade a newer Paseo app.
 */
export async function restorePaseoIntegration(): Promise<{
  restored: string[];
  errors: string[];
}> {
  const restored: string[] = [];
  const errors: string[] = [];
  const home = os.homedir();
  const backupDir = path.join(home, ".paseo", "backups");
  const macBackup = path.join(backupDir, "app.asar.bak");
  const asarCandidates = findPaseoAsarPaths();

  for (const asarPath of asarCandidates) {
    const targetVersion = resolveTargetPaseoVersion(asarPath);
    let backupFile: string | null = null;

    if (process.platform === "darwin" && asarPath.includes(".app")) {
      const versionedCandidate = targetVersion
        ? path.join(backupDir, `app.asar.${targetVersion}.bak`)
        : null;
      if (versionedCandidate && fs.existsSync(versionedCandidate)) {
        backupFile = versionedCandidate;
      } else if (fs.existsSync(macBackup)) {
        backupFile = macBackup;
      }
    } else if (fs.existsSync(`${asarPath}.bak`)) {
      backupFile = `${asarPath}.bak`;
    }

    if (backupFile) {
      const backupVersion = resolveAsarArchiveVersion(backupFile);
      if (targetVersion && backupVersion && targetVersion !== backupVersion) {
        errors.push(
          `Refusing to restore ${asarPath} (v${targetVersion}) from stale backup ${backupFile} (v${backupVersion}) to prevent version downgrade`
        );
        continue;
      }
      if (process.platform === "darwin" && asarPath.includes(".app") && targetVersion && !backupVersion) {
        errors.push(
          `Refusing to restore ${asarPath} (v${targetVersion}) from unverified backup ${backupFile}`
        );
        continue;
      }

      try {
        fs.copyFileSync(backupFile, asarPath);
        restored.push(asarPath);
        if (process.platform === "darwin" && asarPath.includes(".app")) {
          const appIndex = asarPath.indexOf(".app");
          const appBundlePath = asarPath.slice(0, appIndex + 4);
          try {
            execFileSync("xattr", ["-cr", appBundlePath], { stdio: "ignore" });
          } catch {}
        }
      } catch (err: any) {
        errors.push(`Failed restoring ${asarPath}: ${err?.message || err}`);
      }
    }
  }

  return { restored, errors };
}

/**
 * Checks whether a @getpaseo/server installation directory is already patched
 * for Antigravity quota and telemetry support.
 */
export function isPaseoServerPatched(serverDir: string): boolean {
  try {
    if (!fs.existsSync(serverDir)) return false;

    // 1. Check for Paseo 0.11+ builtin-plugins/antigravity-provider
    const pluginDirCandidates = [
      path.join(serverDir, "dist", "server", "builtin-plugins", "antigravity-provider"),
      path.join(serverDir, "dist", "builtin-plugins", "antigravity-provider"),
      path.join(serverDir, "builtin-plugins", "antigravity-provider"),
    ];
    let pluginDir = pluginDirCandidates.find((d) => fs.existsSync(d));

    if (!pluginDir && fs.existsSync(path.join(serverDir, "dist"))) {
      const findPlugin = (dir: string, depth = 0): string | null => {
        if (depth > 5) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && e.name !== "node_modules") {
              if (e.name === "antigravity-provider") return full;
              const found = findPlugin(full, depth + 1);
              if (found) return found;
            }
          }
        } catch {}
        return null;
      };
      pluginDir = findPlugin(path.join(serverDir, "dist")) || undefined;
    }

    if (pluginDir) {
      // Paseo 0.11+ architecture
      const usageFile = [
        path.join(pluginDir, "server", "usage.ts"),
        path.join(pluginDir, "server", "usage.js"),
      ].find((f) => fs.existsSync(f));
      if (!usageFile) return false;
      const usageContent = fs.readFileSync(usageFile, "utf-8");
      if (usageContent.includes('return "critical"')) return false;

      const indexFile = [
        path.join(pluginDir, "index.server.ts"),
        path.join(pluginDir, "index.server.js"),
      ].find((f) => fs.existsSync(f));
      if (!indexFile) return false;

      const indexContent = fs.readFileSync(indexFile, "utf-8");
      if (!indexContent.includes("registerAntigravityUsageSource")) return false;
    } else {
      // Paseo <= 0.10 legacy architecture
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

      if (!hasProvider) return false;

      // Manifest check
      const manifestCandidates = [
        path.join(serverDir, "dist", "server", "services", "quota-fetcher", "manifest.js"),
        path.join(serverDir, "dist", "services", "quota-fetcher", "manifest.js"),
      ];
      let manifestFile = manifestCandidates.find((f) => fs.existsSync(f));
      if (!manifestFile && fs.existsSync(path.join(serverDir, "dist"))) {
        const findManifest = (dir: string, depth = 0): string | null => {
          if (depth > 5) return null;
          try {
            const entries = fs.readdirSync(dir, { withFileTypes: true });
            for (const e of entries) {
              const full = path.join(dir, e.name);
              if (e.isDirectory() && e.name !== "node_modules") {
                const found = findManifest(full, depth + 1);
                if (found) return found;
              } else if (e.isFile() && e.name === "manifest.js" && dir.replace(/\\/g, "/").includes("quota-fetcher")) {
                return full;
              }
            }
          } catch {}
          return null;
        };
        manifestFile = findManifest(path.join(serverDir, "dist")) || undefined;
      }
      if (manifestFile) {
        const content = fs.readFileSync(manifestFile, "utf-8");
        if (!content.includes('providerId: "antigravity"')) {
          return false;
        }
      }
    }

    // 2. ACP Agent check (common to both architectures)
    const acpCandidates = [
      path.join(serverDir, "dist", "server", "server", "agent", "providers", "acp-agent.js"),
      path.join(serverDir, "dist", "server", "agent", "providers", "acp-agent.js"),
      path.join(serverDir, "dist", "agent", "providers", "acp-agent.js"),
    ];
    let acpFile = acpCandidates.find((f) => fs.existsSync(f));
    if (!acpFile && fs.existsSync(path.join(serverDir, "dist"))) {
      const findAcp = (dir: string, depth = 0): string | null => {
        if (depth > 5) return null;
        try {
          const entries = fs.readdirSync(dir, { withFileTypes: true });
          for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory() && e.name !== "node_modules") {
              const found = findAcp(full, depth + 1);
              if (found) return found;
            } else if (e.isFile() && e.name === "acp-agent.js") {
              return full;
            }
          }
        } catch {}
        return null;
      };
      acpFile = findAcp(path.join(serverDir, "dist")) || undefined;
    }
    if (acpFile) {
      const content = fs.readFileSync(acpFile, "utf-8");
      if (!content.includes("this.currentTurnUsage =") || !content.includes("contextWindowMaxTokens")) {
        return false;
      }
      if (pluginDir && (!content.includes("usageSession()") || content.includes("!this.usageProvider"))) {
        return false;
      }
      if (
        content.includes("mapACPUsage(response.usage) ?? this.currentTurnUsage") &&
        !content.includes("_mappedRespUsage")
      ) {
        return false;
      }
    }

    return true;
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
    const files = listPackage(asarPath);
    return files.some((f) => {
      const norm = f.replace(/\\/g, "/");
      return norm.includes("quota-fetcher/providers/antigravity.js") ||
             norm.includes("antigravity-provider/server/usage.");
    });
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
      try {
        const out = execFileSync("pgrep", ["-i", "-f", "paseo (daemon|supervisor)|/paseo$|@getpaseo/server"], {
          encoding: "utf-8",
          timeout: 2000,
        });
        const pids = out
          .split(/\r?\n/)
          .map((s) => parseInt(s.trim(), 10))
          .filter((p) => !isNaN(p) && p !== process.pid && p !== process.ppid);
        if (pids.length > 0) return true;
      } catch {}
      const out2 = execFileSync("pgrep", ["-i", "-x", "paseo"], {
        encoding: "utf-8",
        timeout: 2000,
      });
      const pids2 = out2
        .split(/\r?\n/)
        .map((s) => parseInt(s.trim(), 10))
        .filter((p) => !isNaN(p) && p !== process.pid && p !== process.ppid);
      return pids2.length > 0;
    }
  } catch {
    return false;
  }
}
