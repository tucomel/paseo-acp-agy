import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  findPaseoServerInstallations,
  findPaseoAsarPaths,
  patchPaseoServer,
  patchPaseoAsar,
  ensurePaseoIntegration,
  generateAntigravityQuotaProviderJs,
  generateAntigravityPluginUsageTs,
  isPaseoServerPatched,
  isPaseoAsarPatched,
  isPaseoRunning,
} from "../src/paseo-patcher.js";
import { createPackage, listPackage } from "../src/asar.js";

describe("Paseo Patcher & Telemetry Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-server-test-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should generate valid AntigravityQuotaProvider JavaScript source with Windows fixes", () => {
    const js = generateAntigravityQuotaProviderJs();
    expect(js).toContain("export class AntigravityQuotaProvider");
    expect(js).toContain('this.providerId = "antigravity"');
    expect(js).toContain("resolveAgyBinary()");
    expect(js).toContain("Google Gemini");
    expect(js).toContain("Remaining");
    expect(js).toContain("fetchUsage()");

    // Verify Windows-specific fixes & quota resilience
    expect(js).toContain("BIN_CACHE_TTL_MS = 86400000");
    expect(js).toContain("cachedAgyBin");
    expect(js).toContain("QUOTA_CACHE_TTL_MS = 60000");
    expect(js).toContain("lastSuccessfulQuota");
    expect(js).toContain("timeout: 30000");
    expect(js).toContain("timeout: 6000");
    expect(js).toContain("exeCandidates = [");
    expect(js).toContain("shell: isBatch");
    expect(js).toContain("windowsHide: true");
    expect(js).toContain("replace(/\\r\\n/g, \"\\n\")");
    expect(js).not.toContain('bin = `"${bin}"`');
    expect(js).toContain("providerId: this.providerId");
    expect(js).toContain('displayName: "Antigravity"');
    expect(js).toContain("windows");
    expect(js).toContain("balances");
    expect(js).toContain("claude_");
  });

  it("should patch a simulated @getpaseo/server installation cleanly", () => {
    // Set up directory structure
    const quotaDir = path.join(tempDir, "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    const manifestPath = path.join(quotaDir, "manifest.js");
    fs.writeFileSync(
      manifestPath,
      `import { ClaudeQuotaProvider } from "./providers/claude.js";
export const PROVIDER_USAGE_FETCHERS = [
    {
        providerId: "claude",
        create: (options) => new ClaudeQuotaProvider(options),
    },
];
`,
      "utf-8"
    );

    const agentDir = path.join(tempDir, "dist", "server", "server", "agent", "providers");
    fs.mkdirSync(agentDir, { recursive: true });
    const acpAgentPath = path.join(agentDir, "acp-agent.js");
    fs.writeFileSync(
      acpAgentPath,
      `export function mapACPUsage(usage) {
    if (!usage) {
        return undefined;
    }
    return {
        inputTokens: usage.inputTokens ?? undefined,
        outputTokens: usage.outputTokens ?? undefined,
        cachedInputTokens: usage.cachedReadTokens ?? undefined,
    };
}

class ACPAgentSession {
    handleUsageUpdate(update) {
        void update;
    }
}
`,
      "utf-8"
    );

    const result = patchPaseoServer(tempDir);
    expect(result.success).toBe(true);
    expect(result.changes.length).toBeGreaterThan(0);

    // Verify manifest.js
    const updatedManifest = fs.readFileSync(manifestPath, "utf-8");
    expect(updatedManifest).toContain('import { AntigravityQuotaProvider } from "./providers/antigravity.js"');
    expect(updatedManifest).toContain('providerId: "antigravity"');

    // Verify antigravity.js provider file
    const antigravityFile = path.join(quotaDir, "providers", "antigravity.js");
    expect(fs.existsSync(antigravityFile)).toBe(true);

    // Verify acp-agent.js
    const updatedAcp = fs.readFileSync(acpAgentPath, "utf-8");
    expect(updatedAcp).toContain("contextWindowMaxTokens: usage.contextWindowMaxTokens ?? usage.size ?? undefined");
    expect(updatedAcp).toContain("Math.min(usedTokens, maxTokens)");
    expect(updatedAcp).toContain("deliverTranslatedEvents");
    expect(updatedAcp).toContain('type: "usage_updated"');
  });

  it("should be idempotent when run multiple times on already-patched files", () => {
    const quotaDir = path.join(tempDir, "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    const manifestPath = path.join(quotaDir, "manifest.js");
    fs.writeFileSync(
      manifestPath,
      `import { ClaudeQuotaProvider } from "./providers/claude.js";
export const PROVIDER_USAGE_FETCHERS = [
    {
        providerId: "claude",
        create: (options) => new ClaudeQuotaProvider(options),
    },
];
`,
      "utf-8"
    );

    const firstRun = patchPaseoServer(tempDir);
    expect(firstRun.success).toBe(true);

    const manifestAfterFirst = fs.readFileSync(manifestPath, "utf-8");

    // Second run
    const secondRun = patchPaseoServer(tempDir);
    expect(secondRun.success).toBe(true);

    const manifestAfterSecond = fs.readFileSync(manifestPath, "utf-8");
    expect(manifestAfterSecond).toBe(manifestAfterFirst);
  });

  it("should discover Paseo server installation via PASEO_SERVER_PATH override", () => {
    fs.mkdirSync(path.join(tempDir, "dist"), { recursive: true });
    process.env.PASEO_SERVER_PATH = tempDir;

    const found = findPaseoServerInstallations();
    expect(found).toContain(path.resolve(tempDir));

    delete process.env.PASEO_SERVER_PATH;
  });

  it("should gracefully succeed with ensurePaseoIntegration", async () => {
    const result = await ensurePaseoIntegration({ targetPaths: [tempDir], targetAsarPaths: [] });
    expect(result.found).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("should extract, patch, and repack a Paseo app.asar package", async () => {
    // Create a mock asar source directory
    const asarSrcDir = path.join(tempDir, "mock-app");
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    const manifestPath = path.join(quotaDir, "manifest.js");
    fs.writeFileSync(
      manifestPath,
      `import { ClaudeQuotaProvider } from "./providers/claude.js";
export const PROVIDER_USAGE_FETCHERS = [
    {
        providerId: "claude",
        create: (options) => new ClaudeQuotaProvider(options),
    },
];
`,
      "utf-8"
    );

    const asarPath = path.join(tempDir, "app.asar");
    await createPackage(asarSrcDir, asarPath);

    const patchRes = await patchPaseoAsar(asarPath);
    expect(patchRes.success).toBe(true);
    expect(patchRes.changes.length).toBeGreaterThan(0);

    // Verify backup created
    expect(fs.existsSync(`${asarPath}.bak`)).toBe(true);

    // Verify asar package now contains the antigravity provider
    const files = listPackage(asarPath);
    expect(files.some((f: string) => f.includes("antigravity.js"))).toBe(true);

    // Verify isPaseoAsarPatched reports true
    const isPatched = await isPaseoAsarPatched(asarPath);
    expect(isPatched).toBe(true);
  });

  it("should accurately report isPaseoServerPatched status", () => {
    // Unpatched directory
    expect(isPaseoServerPatched(tempDir)).toBe(false);

    // Setup mock server directory
    const quotaDir = path.join(tempDir, "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    const manifestPath = path.join(quotaDir, "manifest.js");
    fs.writeFileSync(manifestPath, `export const PROVIDER_USAGE_FETCHERS = [];`, "utf-8");

    patchPaseoServer(tempDir);
    expect(isPaseoServerPatched(tempDir)).toBe(true);
  });

  it("should patch handleUsageUpdate in Paseo 0.10.3 where deliverTranslatedEvents is pre-existing", () => {
    const quotaDir = path.join(tempDir, "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    const manifestPath = path.join(quotaDir, "manifest.js");
    fs.writeFileSync(
      manifestPath,
      `export const PROVIDER_USAGE_FETCHERS = [];`,
      "utf-8"
    );

    const agentDir = path.join(tempDir, "dist", "server", "server", "agent", "providers");
    fs.mkdirSync(agentDir, { recursive: true });
    const acpAgentPath = path.join(agentDir, "acp-agent.js");
    fs.writeFileSync(
      acpAgentPath,
      `export function mapACPUsage(usage) {
    if (!usage) return undefined;
    return { inputTokens: usage.inputTokens };
}

class ACPAgentSession {
    deliverTranslatedEvents(events) {
        for (const event of events) {
            this.pushEvent(event);
        }
    }
    handleUsageUpdate(update) {
        void update;
    }
}
`,
      "utf-8"
    );

    // Before patching: isPaseoServerPatched must be false
    expect(isPaseoServerPatched(tempDir)).toBe(false);

    // Apply patch
    const patchResult = patchPaseoServer(tempDir);
    expect(patchResult.success).toBe(true);
    expect(patchResult.changes.some((c) => c.includes("acp-agent.js"))).toBe(true);

    // Verify acp-agent.js was modified
    const patchedCode = fs.readFileSync(acpAgentPath, "utf-8");
    expect(patchedCode).toContain('type: "usage_updated"');
    expect(patchedCode).toContain("this.currentTurnUsage = { ...this.currentTurnUsage, ...usage };");
    expect(patchedCode).toContain("contextWindowMaxTokens: usage.contextWindowMaxTokens ?? usage.size ?? undefined");

    // After patching: isPaseoServerPatched must be true
    expect(isPaseoServerPatched(tempDir)).toBe(true);

    // Subsequent run must be idempotent
    const secondResult = patchPaseoServer(tempDir);
    expect(secondResult.success).toBe(true);
    expect(secondResult.changes.some((c) => c.includes("acp-agent.js"))).toBe(false);
  });

  it("should accurately report isPaseoAsarPatched status", async () => {
    const asarSrcDir = path.join(tempDir, "mock-app-unpatched");
    fs.mkdirSync(asarSrcDir, { recursive: true });
    fs.writeFileSync(path.join(asarSrcDir, "index.js"), "console.log('hello');");
    const asarPath = path.join(tempDir, "unpatched.asar");
    await createPackage(asarSrcDir, asarPath);

    expect(await isPaseoAsarPatched(asarPath)).toBe(false);
  });

  it("should NOT return true for unpatched asar containing native features/editor-targets/targets/antigravity.js", async () => {
    const asarSrcDir = path.join(tempDir, "mock-native-antigravity-target");
    const targetDir = path.join(asarSrcDir, "features", "editor-targets", "targets");
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, "antigravity.js"), "// native paseo editor target");
    const asarPath = path.join(tempDir, "native-target.asar");
    await createPackage(asarSrcDir, asarPath);

    // Must NOT be considered patched because it lacks the quota provider
    expect(await isPaseoAsarPatched(asarPath)).toBe(false);

    // Now add the actual quota provider and verify it reports true
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher", "providers");
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, "antigravity.js"), "// quota provider");
    const patchedAsarPath = path.join(tempDir, "actually-patched.asar");
    await createPackage(asarSrcDir, patchedAsarPath);

    expect(await isPaseoAsarPatched(patchedAsarPath)).toBe(true);
  });

  it("should execute isPaseoRunning safely without throwing", () => {
    const running = isPaseoRunning();
    expect(typeof running).toBe("boolean");
  });

  it("should safely handle locked app.asar on Windows via rename retry strategy", async () => {
    const asarSrcDir = path.join(tempDir, "mock-app-locked");
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, "manifest.js"), `export const PROVIDER_USAGE_FETCHERS = [];`);

    const asarPath = path.join(tempDir, "locked.asar");
    await createPackage(asarSrcDir, asarPath);

    // Spy on fs.copyFileSync to simulate EBUSY on initial replace
    const originalCopyFileSync = fs.copyFileSync;
    let initialCopyFailed = false;
    let fallbackRenameCalled = false;

    const originalRenameSync = fs.renameSync;
    const renameSpy = vi.spyOn(fs, "renameSync").mockImplementation((oldPath, newPath) => {
      fallbackRenameCalled = true;
      return originalRenameSync(oldPath, newPath);
    });

    const copySpy = vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest) => {
      if (dest === asarPath && !initialCopyFailed) {
        initialCopyFailed = true;
        const err: any = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
      return originalCopyFileSync(src, dest);
    });

    const patchRes = await patchPaseoAsar(asarPath);
    expect(patchRes.success).toBe(true);
    expect(initialCopyFailed).toBe(true);
    expect(fallbackRenameCalled).toBe(true);
    expect(patchRes.changes.some((c) => c.includes("safe replaced locked file"))).toBe(true);
  });

  it("should report clear error when both copy and rename fail due to process locking", async () => {
    const asarSrcDir = path.join(tempDir, "mock-app-locked-hard");
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, "manifest.js"), `export const PROVIDER_USAGE_FETCHERS = [];`);

    const asarPath = path.join(tempDir, "locked-hard.asar");
    await createPackage(asarSrcDir, asarPath);

    vi.spyOn(fs, "copyFileSync").mockImplementation((src, dest) => {
      if (dest === asarPath) {
        const err: any = new Error("EBUSY: resource busy or locked");
        err.code = "EBUSY";
        throw err;
      }
    });

    vi.spyOn(fs, "renameSync").mockImplementation(() => {
      const err: any = new Error("EBUSY: resource busy or locked");
      err.code = "EBUSY";
      throw err;
    });

    const patchRes = await patchPaseoAsar(asarPath);
    expect(patchRes.success).toBe(false);
    expect(patchRes.error).toContain("file is locked by a running Paseo process");
    expect(patchRes.error).toContain("Paseo.exe");
  });

  it("should discover asar via PASEO_ASAR_PATH override", () => {
    const mockAsar = path.join(tempDir, "custom.asar");
    fs.writeFileSync(mockAsar, "dummy asar");
    process.env.PASEO_ASAR_PATH = mockAsar;

    const paths = findPaseoAsarPaths();
    expect(paths).toContain(path.resolve(mockAsar));

    delete process.env.PASEO_ASAR_PATH;
  });

  it("should generate valid Paseo 0.11+ Plugin Usage TypeScript source with Windows fixes", () => {
    const ts = generateAntigravityPluginUsageTs();
    expect(ts).toContain("export function registerAntigravityUsageSource");
    expect(ts).toContain("export async function fetchAntigravityUsage");
    expect(ts).toContain('id: "antigravity"');
    expect(ts).toContain('label: "Antigravity"');
    expect(ts).toContain('icon: "icon.svg"');
    expect(ts).toContain("resolveAgyBinary()");
    expect(ts).toContain("Google Gemini");
    expect(ts).toContain("Remaining");

    // Verify Windows-specific fixes
    expect(ts).toContain("RESOLVE_TTL_MS = 30000");
    expect(ts).toContain("cachedAgyBin");
    expect(ts).toContain("winCandidates = [");
    expect(ts).toContain("shell: isBatch");
    expect(ts).toContain("windowsHide: true");
    expect(ts).toContain("replace(/\\r\\n/g, \"\\n\")");
    expect(ts).not.toContain('bin = `"${bin}"`');
    expect(ts).toContain('status: "available"');
    expect(ts).toContain("windows");
    expect(ts).toContain("balances");
    expect(ts).toContain("claude_");
  });

  it("should patch a simulated Paseo 0.11.0 installation (builtin-plugins and stock acp-agent.js)", () => {
    // 1. Set up simulated Paseo 0.11.0 builtin-plugins/antigravity-provider
    const pluginDir = path.join(tempDir, "dist", "server", "builtin-plugins", "antigravity-provider");
    fs.mkdirSync(pluginDir, { recursive: true });
    const indexPath = path.join(pluginDir, "index.server.ts");
    fs.writeFileSync(
      indexPath,
      `import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createAntigravityProvider } from "./server/provider.js";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createAntigravityProvider());
  return () => {};
}
`,
      "utf-8"
    );

    // 2. Set up simulated stock Paseo 0.11.0 acp-agent.js
    const agentDir = path.join(tempDir, "dist", "server", "server", "agent", "providers");
    fs.mkdirSync(agentDir, { recursive: true });
    const acpAgentPath = path.join(agentDir, "acp-agent.js");
    fs.writeFileSync(
      acpAgentPath,
      `export function mapACPUsage(usage) {
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
}

class ACPAgentSession {
    handleUsageUpdate(update) {
        const contextWindowMaxTokens = Number.isFinite(update.size) && update.size > 0 ? update.size : undefined;
        const contextWindowUsedTokens = Number.isFinite(update.used) && update.used >= 0 ? update.used : undefined;
        if (contextWindowMaxTokens === undefined || contextWindowUsedTokens === undefined) {
            return;
        }
        this.pushEvent({
            type: "usage_updated",
            provider: this.provider,
            usage: {
                ...this.currentTurnUsage,
                contextWindowMaxTokens,
                contextWindowUsedTokens,
            },
            turnId: this.activeForegroundTurnId ?? undefined,
        });
    }
}
`,
      "utf-8"
    );

    // Before patching: isPaseoServerPatched must report false
    expect(isPaseoServerPatched(tempDir)).toBe(false);

    // Apply patch
    const patchResult = patchPaseoServer(tempDir);
    expect(patchResult.success).toBe(true);
    expect(patchResult.changes.some((c) => c.includes("usage.ts"))).toBe(true);
    expect(patchResult.changes.some((c) => c.includes("index.server.ts"))).toBe(true);
    expect(patchResult.changes.some((c) => c.includes("acp-agent.js"))).toBe(true);

    // Verify usage.ts was created
    const usageTsPath = path.join(pluginDir, "server", "usage.ts");
    expect(fs.existsSync(usageTsPath)).toBe(true);

    // Verify index.server.ts calls registerAntigravityUsageSource
    const updatedIndex = fs.readFileSync(indexPath, "utf-8");
    expect(updatedIndex).toContain('import { registerAntigravityUsageSource } from "./server/usage.js"');
    expect(updatedIndex).toContain("registerAntigravityUsageSource(server)");

    // Verify acp-agent.js persists this.currentTurnUsage
    const updatedAcp = fs.readFileSync(acpAgentPath, "utf-8");
    expect(updatedAcp).toContain("this.currentTurnUsage = { ...this.currentTurnUsage, ...usage };");

    // After patching: isPaseoServerPatched must report true
    expect(isPaseoServerPatched(tempDir)).toBe(true);

    // Second run must be idempotent
    const secondResult = patchPaseoServer(tempDir);
    expect(secondResult.success).toBe(true);
    expect(secondResult.changes.some((c) => c.includes("index.server.ts"))).toBe(false);
    expect(secondResult.changes.some((c) => c.includes("acp-agent.js"))).toBe(false);
  });

  it("should accurately report isPaseoAsarPatched for Paseo 0.11.0 asar archives", async () => {
    const asarSrcDir = path.join(tempDir, "mock-app-0.11");
    const pluginDir = path.join(
      asarSrcDir,
      "node_modules",
      "@getpaseo",
      "server",
      "dist",
      "server",
      "builtin-plugins",
      "antigravity-provider",
      "server"
    );
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, "usage.ts"), "// usage source");

    const asarPath = path.join(tempDir, "paseo-0.11.asar");
    await createPackage(asarSrcDir, asarPath);

    expect(await isPaseoAsarPatched(asarPath)).toBe(true);
  });
});
