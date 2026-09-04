import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolvePermissionSettings, buildAgyArgs } from "../src/permissions.js";

describe("ACP Permission Settings & CLI Arguments", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.AGY_ACP_SANDBOX;
    delete process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("resolvePermissionSettings", () => {
    it("defaults dangerouslySkipPermissions to true in ACP mode", () => {
      const settings = resolvePermissionSettings();
      expect(settings.dangerouslySkipPermissions).toBe(true);
      expect(settings.sandbox).toBe(false);
    });

    it("respects explicit dangerouslySkipPermissions: false option", () => {
      const settings = resolvePermissionSettings({ dangerouslySkipPermissions: false });
      expect(settings.dangerouslySkipPermissions).toBe(false);
    });

    it("respects explicit dangerouslySkipPermissions: true option", () => {
      const settings = resolvePermissionSettings({ dangerouslySkipPermissions: true });
      expect(settings.dangerouslySkipPermissions).toBe(true);
    });

    it("respects AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS=false environment variable", () => {
      process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS = "false";
      const settings = resolvePermissionSettings();
      expect(settings.dangerouslySkipPermissions).toBe(false);
    });

    it("respects AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS=0 environment variable", () => {
      process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS = "0";
      const settings = resolvePermissionSettings();
      expect(settings.dangerouslySkipPermissions).toBe(false);
    });

    it("respects AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS=true environment variable", () => {
      process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS = "true";
      const settings = resolvePermissionSettings();
      expect(settings.dangerouslySkipPermissions).toBe(true);
    });

    it("options take precedence over environment variables", () => {
      process.env.AGY_ACP_DANGEROUSLY_SKIP_PERMISSIONS = "false";
      const settings = resolvePermissionSettings({ dangerouslySkipPermissions: true });
      expect(settings.dangerouslySkipPermissions).toBe(true);
    });

    it("handles sandbox option and environment variable", () => {
      expect(resolvePermissionSettings({ sandbox: true }).sandbox).toBe(true);

      process.env.AGY_ACP_SANDBOX = "true";
      expect(resolvePermissionSettings().sandbox).toBe(true);
    });

    it("passes mode and addDirs properly", () => {
      const settings = resolvePermissionSettings({
        mode: "plan",
        addDirs: ["/path/to/project", "C:\\Users\\Rafael\\git\\zapcalendarassistente"],
      });
      expect(settings.mode).toBe("plan");
      expect(settings.addDirs).toEqual([
        "/path/to/project",
        "C:\\Users\\Rafael\\git\\zapcalendarassistente",
      ]);
    });
  });

  describe("buildAgyArgs", () => {
    it("includes --dangerously-skip-permissions by default", () => {
      const settings = resolvePermissionSettings();
      const args = buildAgyArgs(settings);
      expect(args).toContain("--dangerously-skip-permissions");
      expect(args).toContain("--input-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--output-format");
      expect(args).toContain("stream-json");
      expect(args).toContain("--print=");
    });

    it("omits --dangerously-skip-permissions when explicitly disabled", () => {
      const settings = resolvePermissionSettings({ dangerouslySkipPermissions: false });
      const args = buildAgyArgs(settings);
      expect(args).not.toContain("--dangerously-skip-permissions");
    });

    it("includes --sandbox when sandbox is true", () => {
      const settings = resolvePermissionSettings({ sandbox: true });
      const args = buildAgyArgs(settings);
      expect(args).toContain("--sandbox");
    });

    it("includes --mode when mode is not default", () => {
      const settings = resolvePermissionSettings({ mode: "plan" });
      const args = buildAgyArgs(settings);
      expect(args).toContain("--mode");
      expect(args[args.indexOf("--mode") + 1]).toBe("plan");
    });

    it("includes --add-dir for each specified directory", () => {
      const settings = resolvePermissionSettings({
        addDirs: ["/home/ubuntu/repo", "C:\\Users\\Rafael\\git\\zapcalendarassistente"],
      });
      const args = buildAgyArgs(settings);
      expect(args).toContain("--add-dir");
      expect(args).toContain("/home/ubuntu/repo");
      expect(args).toContain("C:\\Users\\Rafael\\git\\zapcalendarassistente");
    });

    it("appends extra arguments", () => {
      const settings = resolvePermissionSettings();
      const args = buildAgyArgs(settings, ["--model", "gemini-3.7-flash", "--effort", "high"]);
      expect(args).toContain("--model");
      expect(args).toContain("gemini-3.7-flash");
      expect(args).toContain("--effort");
      expect(args).toContain("high");
    });
  });
});
