import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function getPackageVersion(): string {
  try {
    const pkgPath = path.resolve(__dirname, "..", "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (pkg.version) return pkg.version;
    }
  } catch {
    // ignore
  }
  return "1.1.0";
}

export const SEMVER_VERSION = getPackageVersion();

export interface BuildMetadata {
  version: string;
  gitCommit: string;
  gitCommitShort: string;
  gitBranch: string;
  gitCommitDate: string;
  isDirty: boolean;
  nodeVersion: string;
  platform: string;
  arch: string;
  agyVersion: string;
  agyBinaryPath: string;
}

let cachedBuildMetadata: BuildMetadata | null = null;

function safeGit(cmd: string, cwd: string): string {
  try {
    return execSync(cmd, { cwd, stdio: ["ignore", "pipe", "ignore"], encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

function resolveAgyInfo(): { version: string; binaryPath: string } {
  let binaryPath = process.env.AGY_BIN_PATH;
  if (!binaryPath) {
    try {
      const lookupCmd =
        process.platform === "win32"
          ? "where.exe agy"
          : "which agy 2>/dev/null || command -v agy 2>/dev/null";
      const output = execSync(lookupCmd, { encoding: "utf8" }).trim();
      if (output) {
        binaryPath = output.split(/\r?\n/)[0].trim();
      }
    } catch {
      // ignore
    }
  }
  if (!binaryPath) {
    const homeDir = os.homedir();
    if (homeDir) {
      const candidates =
        process.platform === "win32"
          ? [
              path.join(homeDir, ".local", "bin", "agy.exe"),
              path.join(homeDir, "AppData", "Local", "Programs", "antigravity", "agy.exe"),
              path.join(homeDir, ".local", "bin", "agy.cmd"),
              path.join(homeDir, ".local", "bin", "agy.bat"),
            ]
          : [path.join(homeDir, ".local", "bin", "agy")];

      for (const cand of candidates) {
        if (fs.existsSync(cand)) {
          binaryPath = cand;
          break;
        }
      }
    }
  }
  if (!binaryPath) binaryPath = "agy";
  try {
    const version = execSync(`"${binaryPath}" --version`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      timeout: 3000,
    }).trim();
    return { version, binaryPath };
  } catch {
    return { version: "unknown", binaryPath };
  }
}

export function resolveBuildMetadata(): BuildMetadata {
  if (cachedBuildMetadata) return cachedBuildMetadata;

  const repoRoot = path.resolve(__dirname, "..");
  const gitCommitShort = safeGit("git rev-parse --short HEAD", repoRoot) || "unknown";
  const gitCommit = safeGit("git rev-parse HEAD", repoRoot) || "unknown";
  const gitBranch = safeGit("git rev-parse --abbrev-ref HEAD", repoRoot) || "unknown";
  const gitCommitDate = safeGit("git log -1 --format=%cI", repoRoot) || new Date().toISOString();

  // Check if uncommitted changes exist in repo
  const dirtyCheck = safeGit("git status --porcelain", repoRoot);
  const isDirty = dirtyCheck.length > 0;

  const agyInfo = resolveAgyInfo();

  const metadata: BuildMetadata = {
    version: SEMVER_VERSION,
    gitCommit,
    gitCommitShort,
    gitBranch,
    gitCommitDate,
    isDirty,
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    agyVersion: agyInfo.version,
    agyBinaryPath: agyInfo.binaryPath,
  };

  cachedBuildMetadata = metadata;
  return metadata;
}

export function getShortVersion(): string {
  const meta = resolveBuildMetadata();
  const dirtySuffix = meta.isDirty ? "-dirty" : "";
  const commitSuffix = meta.gitCommitShort !== "unknown" ? `-${meta.gitCommitShort}` : "";
  return `${meta.version}${commitSuffix}${dirtySuffix}`;
}

export function formatDiagnosticVersion(): string {
  const meta = resolveBuildMetadata();
  const dirtyFlag = meta.isDirty ? " (dirty)" : "";
  const commitShort = meta.gitCommitShort !== "unknown" ? meta.gitCommitShort : "dist";
  const formattedDate = meta.gitCommitDate ? meta.gitCommitDate.replace("T", " ").slice(0, 16) + " UTC" : "";

  const lines = [
    `${meta.version} (rev: ${commitShort}${dirtyFlag} • branch: ${meta.gitBranch} • ${formattedDate})`,
    `  • Commit SHA: ${meta.gitCommit}`,
    `  • CLI Backend: ${meta.agyBinaryPath} (v${meta.agyVersion})`,
    `  • Runtime: Node.js ${meta.nodeVersion} (${meta.platform} ${meta.arch})`,
    `  • Features: Token Tracking, Context Meter, Quota Windows, Model Pricing, Slash Commands (/help, /resume, /usage)`,
    `  • Supported Models: 7 (gemini-3.8-flash, gemini-3.7-flash, gemini-3.6-flash, gemini-3.1-pro, claude-sonnet-4-6, claude-opus-4-6-thinking, gpt-oss-120b)`,
    `  • Session Isolation: persistent agy subprocess per Paseo session`,
  ];

  return lines.join("\n  ");
}
