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
  isPaseoServerPatched,
  isPaseoAsarPatched,
  isPaseoRunning,
} from "../src/paseo-patcher.js";

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

    // Verify Windows-specific fixes
    expect(js).toContain("BIN_CACHE_TTL_MS = 30000");
    expect(js).toContain("cachedAgyBin");
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
    const asarModule = await import("@electron/asar");
    const asar = asarModule.default || asarModule;

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
    await asar.createPackage(asarSrcDir, asarPath);

    const patchRes = await patchPaseoAsar(asarPath);
    expect(patchRes.success).toBe(true);
    expect(patchRes.changes.length).toBeGreaterThan(0);

    // Verify backup created
    expect(fs.existsSync(`${asarPath}.bak`)).toBe(true);

    // Verify asar package now contains the antigravity provider
    try { asar.uncache(asarPath); } catch {}
    const files = asar.listPackage(asarPath);
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

  it("should accurately report isPaseoAsarPatched status", async () => {
    const asarModule = await import("@electron/asar");
    const asar = asarModule.default || asarModule;

    const asarSrcDir = path.join(tempDir, "mock-app-unpatched");
    fs.mkdirSync(asarSrcDir, { recursive: true });
    fs.writeFileSync(path.join(asarSrcDir, "index.js"), "console.log('hello');");
    const asarPath = path.join(tempDir, "unpatched.asar");
    await asar.createPackage(asarSrcDir, asarPath);

    expect(await isPaseoAsarPatched(asarPath)).toBe(false);
  });

  it("should execute isPaseoRunning safely without throwing", () => {
    const running = isPaseoRunning();
    expect(typeof running).toBe("boolean");
  });

  it("should safely handle locked app.asar on Windows via rename retry strategy", async () => {
    const asarModule = await import("@electron/asar");
    const asar = asarModule.default || asarModule;

    const asarSrcDir = path.join(tempDir, "mock-app-locked");
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, "manifest.js"), `export const PROVIDER_USAGE_FETCHERS = [];`);

    const asarPath = path.join(tempDir, "locked.asar");
    await asar.createPackage(asarSrcDir, asarPath);

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
    const asarModule = await import("@electron/asar");
    const asar = asarModule.default || asarModule;

    const asarSrcDir = path.join(tempDir, "mock-app-locked-hard");
    const quotaDir = path.join(asarSrcDir, "node_modules", "@getpaseo", "server", "dist", "server", "services", "quota-fetcher");
    fs.mkdirSync(quotaDir, { recursive: true });
    fs.writeFileSync(path.join(quotaDir, "manifest.js"), `export const PROVIDER_USAGE_FETCHERS = [];`);

    const asarPath = path.join(tempDir, "locked-hard.asar");
    await asar.createPackage(asarSrcDir, asarPath);

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
});
