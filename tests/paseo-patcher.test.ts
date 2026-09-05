import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  findPaseoServerInstallations,
  patchPaseoServer,
  ensurePaseoIntegration,
  generateAntigravityQuotaProviderJs,
} from "../src/paseo-patcher.js";

describe("Paseo Patcher & Telemetry Integration", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "paseo-server-test-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  it("should generate valid AntigravityQuotaProvider JavaScript source", () => {
    const js = generateAntigravityQuotaProviderJs();
    expect(js).toContain("export class AntigravityQuotaProvider");
    expect(js).toContain('this.providerId = "antigravity"');
    expect(js).toContain("resolveAgyBinary()");
    expect(js).toContain("Google Gemini");
    expect(js).toContain("Remaining");
    expect(js).toContain("fetchUsage()");
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

  it("should gracefully succeed with ensurePaseoIntegration", () => {
    const result = ensurePaseoIntegration({ targetPaths: [tempDir] });
    expect(result.found).toBe(true);
    expect(result.errors).toHaveLength(0);
  });
});
