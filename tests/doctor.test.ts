import fs from "node:fs";
import { beforeAll, describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entrypoint = path.resolve(__dirname, "..", "dist", "index.js");

beforeAll(() => {
  if (!fs.existsSync(entrypoint)) {
    const tscBin = path.resolve(__dirname, "..", "node_modules", "typescript", "bin", "tsc");
    execFileSync(process.execPath, [tscBin], {
      cwd: path.resolve(__dirname, ".."),
      encoding: "utf-8",
      timeout: 30000,
    });
  }
});

describe("Doctor Diagnostic CLI", () => {
  it("outputs diagnostic sections with doctor command", () => {
    const out = execFileSync("node", [entrypoint, "doctor"], {
      encoding: "utf-8",
      timeout: 20000,
    });

    expect(out).toContain("=== Paseo & Antigravity Doctor ===");
    expect(out).toContain("Operating System:");
    expect(out).toContain("1. Antigravity Binary Resolution:");
    expect(out).toContain("2. CLI Telemetry & Runtime Probes:");
    expect(out).toContain("3. Paseo Installation Targets:");
    expect(out).toContain("4. Paseo Process Status:");
    expect(out).toContain("=== Doctor Recommendations ===");
  });

  it("outputs diagnostic sections with --doctor flag", () => {
    const out = execFileSync("node", [entrypoint, "--doctor"], {
      encoding: "utf-8",
      timeout: 20000,
    });

    expect(out).toContain("=== Paseo & Antigravity Doctor ===");
    expect(out).toContain("Operating System:");
    expect(out).toContain("1. Antigravity Binary Resolution:");
    expect(out).toContain("2. CLI Telemetry & Runtime Probes:");
    expect(out).toContain("3. Paseo Installation Targets:");
    expect(out).toContain("4. Paseo Process Status:");
  });

  it("displays doctor command in help text", () => {
    const out = execFileSync("node", [entrypoint, "--help"], {
      encoding: "utf-8",
      timeout: 5000,
    });

    expect(out).toContain("npx -y paseo-acp-agy doctor");
    expect(out).toContain("doctor         Diagnose Antigravity binary, quota provider, and Paseo status");
    expect(out).toContain("--doctor          Run environment, binary, and telemetry diagnostics");
  });
});
