import { describe, it, expect } from "vitest";
import {
  resolveBuildMetadata,
  getShortVersion,
  formatDiagnosticVersion,
  SEMVER_VERSION,
} from "../src/version.js";

describe("Automated Versioning & Diagnostic Metadata", () => {
  it("resolves valid build metadata", () => {
    const meta = resolveBuildMetadata();
    expect(meta.version).toBe(SEMVER_VERSION);
    expect(meta.version).toMatch(/^\d+\.\d+\.\d+/);
    expect(meta.nodeVersion).toMatch(/^v\d+/);
    expect(meta.platform).toBe(process.platform);
    expect(meta.arch).toBe(process.arch);
    expect(typeof meta.isDirty).toBe("boolean");
  });

  it("produces short version matching semver and git hash", () => {
    const short = getShortVersion();
    expect(short).toContain(SEMVER_VERSION);
  });

  it("formats rich multi-line diagnostic version string", () => {
    const diagnostic = formatDiagnosticVersion();
    expect(diagnostic).toContain(SEMVER_VERSION);
    expect(diagnostic).toContain("Commit SHA:");
    expect(diagnostic).toContain("CLI Backend:");
    expect(diagnostic).toContain("Runtime: Node.js");
    expect(diagnostic).toContain("Features: Token Tracking, Context Meter, Quota Windows");
    expect(diagnostic).toContain("Supported Models: 7");
  });
});
