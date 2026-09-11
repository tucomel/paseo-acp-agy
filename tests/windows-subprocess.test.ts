import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as childProcess from "node:child_process";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: vi.fn((...args) => actual.spawn(...args)),
    execFile: vi.fn((...args) => (actual.execFile as any)(...args)),
    execFileSync: vi.fn((...args) => (actual.execFileSync as any)(...args)),
  };
});

import {
  resolveDefaultAgyBinary,
  clearBinaryResolutionCache,
  isWindowsBatchScript,
  AntigravityProcess,
} from "../src/antigravity-process.js";
import {
  formatExecBinaryPath,
  resolveCommandExecution,
  fetchAntigravityUsage,
  fetchAvailableModels,
} from "../src/protocol.js";
import { executeSlashCommand } from "../src/slash-commands.js";
import { Session } from "../src/session.js";

describe("Windows Subprocess & Zero-Console Execution", () => {
  const originalPlatform = process.platform;
  const originalEnv = { ...process.env };
  let tempDir: string;

  beforeEach(() => {
    clearBinaryResolutionCache();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "win-subproc-test-"));
  });

  afterEach(() => {
    clearBinaryResolutionCache();
    process.env = { ...originalEnv };
    Object.defineProperty(process, "platform", { value: originalPlatform });
    vi.restoreAllMocks();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe("isWindowsBatchScript", () => {
    it("detects .cmd and .bat extensions case-insensitively", () => {
      expect(isWindowsBatchScript("C:\\npm\\agy.cmd")).toBe(true);
      expect(isWindowsBatchScript("C:\\npm\\agy.CMD")).toBe(true);
      expect(isWindowsBatchScript("C:\\npm\\agy.bat")).toBe(true);
      expect(isWindowsBatchScript("C:\\npm\\agy.BAT")).toBe(true);
      expect(isWindowsBatchScript("/usr/local/bin/agy.cmd")).toBe(true);
    });

    it("returns false for .exe and non-batch files", () => {
      expect(isWindowsBatchScript("C:\\Antigravity\\bin\\agy.exe")).toBe(false);
      expect(isWindowsBatchScript("C:\\Antigravity\\bin\\agy.EXE")).toBe(false);
      expect(isWindowsBatchScript("agy")).toBe(false);
      expect(isWindowsBatchScript("/usr/bin/agy")).toBe(false);
      expect(isWindowsBatchScript("agy.sh")).toBe(false);
      expect(isWindowsBatchScript("agy.ps1")).toBe(false);
    });
  });

  describe("formatExecBinaryPath & resolveCommandExecution", () => {
    it("does NOT wrap binaryPath in quotes when shell is false, even with spaces", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const exePath = "C:\\Program Files\\Antigravity\\bin\\agy.exe";

      expect(formatExecBinaryPath(exePath)).toBe(exePath);
      expect(formatExecBinaryPath(exePath, false)).toBe(exePath);

      const resolved = resolveCommandExecution(exePath);
      expect(resolved.cmd).toBe(exePath);
      expect(resolved.shell).toBe(false);
    });

    it("wraps binaryPath in quotes only when shell is true and path contains spaces", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const batchWithSpace = "C:\\Program Files\\npm\\agy.cmd";

      expect(formatExecBinaryPath(batchWithSpace)).toBe(`"${batchWithSpace}"`);
      expect(formatExecBinaryPath(batchWithSpace, true)).toBe(`"${batchWithSpace}"`);

      const resolved = resolveCommandExecution(batchWithSpace);
      expect(resolved.cmd).toBe(`"${batchWithSpace}"`);
      expect(resolved.shell).toBe(true);
    });

    it("leaves paths without spaces unquoted even for batch scripts", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const batchWithoutSpace = "C:\\npm\\agy.cmd";

      expect(formatExecBinaryPath(batchWithoutSpace)).toBe(batchWithoutSpace);
      const resolved = resolveCommandExecution(batchWithoutSpace);
      expect(resolved.cmd).toBe(batchWithoutSpace);
      expect(resolved.shell).toBe(true);
    });
  });

  describe("Binary Resolution with TTL Cache", () => {
    it("returns cached binary on subsequent calls within TTL", () => {
      const fakeBinary = path.join(tempDir, "agy.exe");
      fs.writeFileSync(fakeBinary, "binary");

      process.env.AGY_BIN_PATH = fakeBinary;
      const first = resolveDefaultAgyBinary();
      expect(first).toBe(fakeBinary);

      process.env.AGY_BIN_PATH = "/other/path/agy.exe";
      const second = resolveDefaultAgyBinary();
      expect(second).toBe(fakeBinary);

      const forced = resolveDefaultAgyBinary(true);
      expect(forced).toBe("/other/path/agy.exe");
    });

    it("re-resolves when cache expires after 24 hours", () => {
      const fakeBinary = path.join(tempDir, "agy.exe");
      fs.writeFileSync(fakeBinary, "binary");
      process.env.AGY_BIN_PATH = fakeBinary;

      let currentTime = 100_000;
      vi.spyOn(Date, "now").mockImplementation(() => currentTime);

      const first = resolveDefaultAgyBinary();
      expect(first).toBe(fakeBinary);

      // Advance 12 hours (within 24h TTL) -> still cached
      currentTime += 12 * 60 * 60 * 1000;
      process.env.AGY_BIN_PATH = "/new/path/agy.exe";
      expect(resolveDefaultAgyBinary()).toBe(fakeBinary);

      // Advance past 24 hours -> expires and re-resolves
      currentTime += 13 * 60 * 60 * 1000;
      expect(resolveDefaultAgyBinary()).toBe("/new/path/agy.exe");
    });

    it("re-resolves when cached file no longer exists on disk", () => {
      const fakeBinary = path.join(tempDir, "agy.exe");
      fs.writeFileSync(fakeBinary, "binary");
      process.env.AGY_BIN_PATH = fakeBinary;

      const first = resolveDefaultAgyBinary();
      expect(first).toBe(fakeBinary);

      fs.unlinkSync(fakeBinary);
      process.env.AGY_BIN_PATH = "/fallback/agy.exe";

      const second = resolveDefaultAgyBinary();
      expect(second).toBe("/fallback/agy.exe");
    });

    it("clearBinaryResolutionCache clears the cache immediately", () => {
      const fakeBinary = path.join(tempDir, "agy.exe");
      fs.writeFileSync(fakeBinary, "binary");
      process.env.AGY_BIN_PATH = fakeBinary;

      expect(resolveDefaultAgyBinary()).toBe(fakeBinary);

      process.env.AGY_BIN_PATH = "/updated/agy.exe";
      clearBinaryResolutionCache();
      expect(resolveDefaultAgyBinary()).toBe("/updated/agy.exe");
    });
  });

  describe("Windows Binary Resolution Priority", () => {
    it("strictly prioritizes .exe candidates over .cmd or .bat", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      delete process.env.AGY_BIN_PATH;

      const localAppData = path.join(tempDir, "LocalAppData");
      const appData = path.join(tempDir, "AppData");
      process.env.LOCALAPPDATA = localAppData;
      process.env.APPDATA = appData;
      process.env.ProgramFiles = path.join(tempDir, "ProgramFiles");
      process.env["ProgramFiles(x86)"] = path.join(tempDir, "ProgramFilesX86");

      const cmdPath = path.join(appData, "npm", "agy.cmd");
      fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
      fs.writeFileSync(cmdPath, "@echo off");

      const exePath = path.join(localAppData, "Programs", "Antigravity", "bin", "agy.exe");
      fs.mkdirSync(path.dirname(exePath), { recursive: true });
      fs.writeFileSync(exePath, "MZ_EXE");

      const resolved = resolveDefaultAgyBinary(true);
      expect(resolved).toBe(exePath);
    });

    it("finds .exe from where.exe output and prioritizes it over batch scripts", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      delete process.env.AGY_BIN_PATH;

      const localAppData = path.join(tempDir, "LocalAppData");
      const appData = path.join(tempDir, "AppData");
      process.env.LOCALAPPDATA = localAppData;
      process.env.APPDATA = appData;

      const cmdPath = path.join(appData, "npm", "agy.cmd");
      fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
      fs.writeFileSync(cmdPath, "@echo off");

      const customExePath = path.join(tempDir, "custom", "bin", "agy.exe");
      fs.mkdirSync(path.dirname(customExePath), { recursive: true });
      fs.writeFileSync(customExePath, "MZ_EXE");

      vi.mocked(childProcess.execFileSync).mockImplementation((cmd: any, args: any) => {
        if (cmd === "where.exe" && Array.isArray(args) && args[0] === "agy") {
          return `${cmdPath}\r\n${customExePath}\r\n` as any;
        }
        throw new Error("Command not found");
      });

      const resolved = resolveDefaultAgyBinary(true);
      expect(resolved).toBe(customExePath);
    });

    it("falls back to .cmd/.bat only when NO .exe is found anywhere", () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      delete process.env.AGY_BIN_PATH;

      const appData = path.join(tempDir, "AppData");
      process.env.APPDATA = appData;
      process.env.LOCALAPPDATA = path.join(tempDir, "LocalAppData");
      process.env.ProgramFiles = path.join(tempDir, "ProgramFiles");
      process.env["ProgramFiles(x86)"] = path.join(tempDir, "ProgramFilesX86");

      const cmdPath = path.join(appData, "npm", "agy.cmd");
      fs.mkdirSync(path.dirname(cmdPath), { recursive: true });
      fs.writeFileSync(cmdPath, "@echo off");

      vi.mocked(childProcess.execFileSync).mockImplementation(() => {
        throw new Error("where.exe not found");
      });

      const resolved = resolveDefaultAgyBinary(true);
      expect(resolved).toBe(cmdPath);
    });
  });

  describe("Zero-Console spawn in AntigravityProcess", () => {
    it("spawns with shell: false, windowsHide: true when binary is .exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const exeBinary = path.join(tempDir, "agy.exe");
      fs.writeFileSync(exeBinary, "MZ");

      let spawnOptions: any;
      const fakeChild: any = {
        pid: 12345,
        stdin: { write: vi.fn(), writable: true },
        stdout: { on: vi.fn(), setEncoding: vi.fn() },
        stderr: { on: vi.fn(), setEncoding: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockImplementation((_bin: any, _args: any, opts: any) => {
        spawnOptions = opts;
        return fakeChild as any;
      });

      const proc = new AntigravityProcess({ binaryPath: exeBinary, cwd: tempDir });
      await proc.start();

      expect(spawnOptions).toBeDefined();
      expect(spawnOptions.shell).toBe(false);
      expect(spawnOptions.windowsHide).toBe(true);
      expect(spawnOptions.detached).toBe(false);
    });

    it("spawns with shell: true, windowsHide: true when binary is .cmd on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const cmdBinary = path.join(tempDir, "agy.cmd");
      fs.writeFileSync(cmdBinary, "@echo off");

      let spawnOptions: any;
      const fakeChild: any = {
        pid: 12346,
        stdin: { write: vi.fn(), writable: true },
        stdout: { on: vi.fn(), setEncoding: vi.fn() },
        stderr: { on: vi.fn(), setEncoding: vi.fn() },
        on: vi.fn(),
        kill: vi.fn(),
      };

      vi.mocked(childProcess.spawn).mockImplementation((_bin: any, _args: any, opts: any) => {
        spawnOptions = opts;
        return fakeChild as any;
      });

      const proc = new AntigravityProcess({ binaryPath: cmdBinary, cwd: tempDir });
      await proc.start();

      expect(spawnOptions).toBeDefined();
      expect(spawnOptions.shell).toBe(true);
      expect(spawnOptions.windowsHide).toBe(true);
      expect(spawnOptions.detached).toBe(false);
    });
  });

  describe("Zero-Console in protocol.ts (fetchAntigravityUsage & fetchAvailableModels)", () => {
    it("fetchAntigravityUsage passes unquoted cmd and shell: false for .exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const exeWithSpaces = "C:\\Program Files\\Antigravity\\bin\\agy.exe";

      vi.mocked(childProcess.execFile).mockImplementation(((cmd: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === "function" ? opts : cb;
        const options = typeof opts === "function" ? {} : opts;

        expect(cmd).toBe(exeWithSpaces); // No quotes!
        expect(options.shell).toBe(false);
        expect(options.windowsHide).toBe(true);

        callback(null, { stdout: "Quota:\nGemini Models  Weekly Limit Remaining  100%\n", stderr: "" });
        return {} as any;
      }) as any);

      await fetchAntigravityUsage(exeWithSpaces, true);
    });

    it("fetchAvailableModels passes unquoted cmd and shell: false for .exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const exeWithSpaces = "C:\\Program Files\\Antigravity\\bin\\agy.exe";

      vi.mocked(childProcess.execFile).mockImplementation(((cmd: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === "function" ? opts : cb;
        const options = typeof opts === "function" ? {} : opts;

        expect(cmd).toBe(exeWithSpaces); // No quotes!
        expect(options.shell).toBe(false);
        expect(options.windowsHide).toBe(true);

        callback(null, { stdout: "gemini-3.7-flash-high\tGemini 3.7 Flash\n", stderr: "" });
        return {} as any;
      }) as any);

      await fetchAvailableModels(exeWithSpaces, true);
    });
  });

  describe("Zero-Console in slash-commands.ts", () => {
    it("passes unquoted cmd and shell: false for .exe on Windows", async () => {
      Object.defineProperty(process, "platform", { value: "win32" });
      const exeWithSpaces = "C:\\Program Files\\Antigravity\\bin\\agy.exe";

      vi.mocked(childProcess.execFile).mockImplementation(((cmd: any, _args: any, opts: any, cb: any) => {
        const callback = typeof opts === "function" ? opts : cb;
        const options = typeof opts === "function" ? {} : opts;

        expect(cmd).toBe(exeWithSpaces); // No quotes!
        expect(options.shell).toBe(false);
        expect(options.windowsHide).toBe(true);

        callback(null, { stdout: "Credits: 100", stderr: "" });
        return {} as any;
      }) as any);

      const session = new Session({ cwd: tempDir, model: "gemini-3.7-flash" });
      const result = await executeSlashCommand("/credits", session, exeWithSpaces);
      expect(result.handled).toBe(true);
    });
  });
});
